import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
// P1-6: pure helpers extracted for testability (no behavior change).
import {
  statusIcon as statusIconPure,
  titleCase as titleCasePure,
  formatAgentStreamEvent as formatAgentStreamEventPure,
  buildEmptyChatFallback as buildEmptyChatFallbackPure,
  compactStatusText as compactStatusTextPure,
  stripMarkdownCodeFence as stripMarkdownCodeFencePure,
  cleanInlineSuggestion as cleanInlineSuggestionPure,
  normalizeReplacementForRange as normalizeReplacementForRangePure,
  clampNumber as clampNumberPure,
  getCandidateBaseUrlsFrom
} from './textUtils';

type ChatRole = 'user' | 'assistant' | 'system';

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type StreamEvent = {
  type?: string;
  text?: string;
  status?: string;
  error?: string;
  tool?: string;
  state?: string;
  log?: string;
  payload?: unknown;
  result?: unknown;
};

type SelectionPayload = {
  file: string;
  absolutePath: string;
  code: string;
  startLine: number;
  endLine: number;
};

type ApiBootstrap = {
  baseUrl: string;
  token: string;
};

type AutocompleteResponse = {
  ok: boolean;
  id?: string;
  suggestion?: string;
  cacheHit?: boolean;
  duplicateRemoved?: boolean;
  latencyMs?: number;
  error?: string;
};

type PendingInlineCompletion = {
  id: string;
  uri: string;
  offset: number;
  suggestion: string;
  offeredAt: number;
  latencyMs?: number;
};

const pendingInlineCompletions = new Map<string, PendingInlineCompletion>();
const INLINE_COMPLETION_FEEDBACK_TIMEOUT_MS = 30_000;

type InlineEditResponse = {
  ok: boolean;
  replacement?: string;
  error?: string;
};

type PatchPreview = {
  ok?: boolean;
  type?: string;
  path?: string;
  error?: string;
  diff?: string;
};

type PatchTransaction = {
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  workspaceRoot?: string;
  operations?: unknown[];
  review?: {
    ok?: boolean;
    changedFiles?: string[];
    previews?: PatchPreview[];
  };
  applyResult?: {
    ok?: boolean;
    changedFiles?: string[];
    previews?: PatchPreview[];
  };
  rollbackResult?: {
    ok?: boolean;
    changedFiles?: string[];
  };
};

type DiffTransactionsResponse = {
  transactions: PatchTransaction[];
};

type DiffTransactionResponse = {
  transaction: PatchTransaction;
};

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('BlackHole');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'blackhole.focusChat';
  status.text = '$(circle-large-outline) BlackHole';
  status.tooltip = 'Open BlackHole Developer Agent';
  status.show();

  const client = new BlackHoleClient(output);
  const sidebarProvider = new BlackHoleSidebarProvider(context, client, output, status);
  const editorSelector: vscode.DocumentSelector = [
    { scheme: 'file' },
    { scheme: 'untitled' }
  ];

  context.subscriptions.push(output, status);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('blackhole.sidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.focusChat', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.blackhole-explorer');
    await sidebarProvider.connect({ silent: true });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.connect', async () => {
    await sidebarProvider.connect({ silent: false });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.setWorkspace', async () => {
    await sidebarProvider.syncWorkspace({ silent: false });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.addToContext', async () => {
    const selection = getActiveSelection();
    if (!selection) {
      vscode.window.showWarningMessage('Select code in the editor before adding context to BlackHole.');
      return;
    }
    sidebarProvider.sendSelectionToWebview(selection);
    await vscode.commands.executeCommand('workbench.view.extension.blackhole-explorer');
    vscode.window.showInformationMessage('Selected code was attached to BlackHole context.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.askAboutSelection', async () => {
    const selection = getActiveSelection();
    if (!selection) {
      vscode.window.showWarningMessage('Select code in the editor before asking BlackHole.');
      return;
    }
    await vscode.commands.executeCommand('workbench.view.extension.blackhole-explorer');
    sidebarProvider.sendSelectionToWebview(selection);
    sidebarProvider.prefillPrompt(`Review this selected code and suggest the safest improvement.\n\n${formatSelectionForPrompt(selection)}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.resumeLatest', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.blackhole-explorer');
    await sidebarProvider.resumeLatestCheckpoint();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.explainSelection', async () => {
    const selection = getActiveSelection();
    if (!selection) {
      vscode.window.showWarningMessage('Select code in the editor before asking BlackHole to explain it.');
      return;
    }
    await vscode.commands.executeCommand('workbench.view.extension.blackhole-explorer');
    sidebarProvider.sendSelectionToWebview(selection);
    sidebarProvider.prefillPrompt(`Explain this selected code, including its responsibility, data flow, and likely edge cases.\n\n${formatSelectionForPrompt(selection)}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.inlineEdit', async (instruction?: string) => {
    await runInlineEdit(client, output, instruction);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.fixDiagnostics', async (diagnostics?: vscode.Diagnostic[]) => {
    await runFixDiagnostics(client, output, diagnostics);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.generateCompletion', async () => {
    await runManualCompletion(client, output);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.reviewAgentDiffs', async (transactionId?: string) => {
    await runDiffReview(client, output, transactionId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.acceptDiffTransaction', async (transactionId?: string) => {
    await runDiffTransactionAction(client, output, 'accept', transactionId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.rejectDiffTransaction', async (transactionId?: string) => {
    await runDiffTransactionAction(client, output, 'reject', transactionId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.rollbackDiffTransaction', async (transactionId?: string) => {
    await runDiffTransactionAction(client, output, 'rollback', transactionId);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.runAgentTask', async (prompt?: string) => {
    await runAgentTask(client, output, { prompt, includeSelection: false });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('blackhole.runAgentTaskWithSelection', async (prompt?: string) => {
    await runAgentTask(client, output, { prompt, includeSelection: true });
  }));

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      editorSelector,
      new BlackHoleInlineCompletionProvider(client, output)
    )
  );

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    reportInlineCompletionAcceptance(client, output, event);
  }));

  const inlineCompletionFeedbackTimer = setInterval(() => {
    expireInlineCompletionFeedback(client, output);
  }, 10_000);
  context.subscriptions.push({
    dispose: () => clearInterval(inlineCompletionFeedbackTimer)
  });

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      editorSelector,
      new BlackHoleCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(editorSelector, new BlackHoleCodeLensProvider())
  );

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    sidebarProvider.sendSelectionToWebview(getActiveSelection());
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    const selection = getSelectionFromEditor(event.textEditor);
    if (selection) {
      sidebarProvider.sendSelectionToWebview(selection);
    }
  }));
}

class BlackHoleClient {
  private bootstrap?: ApiBootstrap;

  constructor(private readonly output: vscode.OutputChannel) {}

  get baseUrl() {
    return this.bootstrap?.baseUrl || getConfiguredBaseUrl();
  }

  get isConnected() {
    return !!this.bootstrap?.token;
  }

  async connect(): Promise<ApiBootstrap> {
    const errors: string[] = [];
    for (const baseUrl of getCandidateBaseUrls()) {
      try {
        const bootstrap = await requestJson<ApiBootstrap>('GET', `${baseUrl}/api/bootstrap`);
        if (bootstrap?.baseUrl && bootstrap?.token) {
          this.bootstrap = bootstrap;
          return bootstrap;
        }
        errors.push(`${baseUrl}: invalid bootstrap response`);
      } catch (error) {
        errors.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.bootstrap = undefined;
    this.output.appendLine('[connect] BlackHole API connection failed.');
    for (const error of errors.slice(0, 5)) {
      this.output.appendLine(`  ${error}`);
    }
    throw new Error('BlackHole API is not reachable. Start the BlackHole desktop app, then run "BlackHole: Connect to Local Agent".');
  }

  async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const bootstrap = await this.ensureConnected();
    return requestJson<T>(method, `${bootstrap.baseUrl}/api${apiPath}`, body, bootstrap.token);
  }

  async stream(apiPath: string, body: unknown, onEvent: (event: StreamEvent) => void): Promise<void> {
    const bootstrap = await this.ensureConnected();
    await streamSse(`${bootstrap.baseUrl}/api${apiPath}`, body, bootstrap.token, onEvent);
  }

  private async ensureConnected() {
    if (this.bootstrap?.token) return this.bootstrap;
    return this.connect();
  }
}

class BlackHoleInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly client: BlackHoleClient,
    private readonly output: vscode.OutputChannel
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = getConfiguration();
    if (!config.get<boolean>('inlineCompletions.enabled', true)) return undefined;
    if (document.isClosed || document.lineCount === 0) return undefined;

    const delayMs = clampNumber(config.get<number>('inlineCompletions.debounceMs', 220), 100, 300, 220);
    await sleep(delayMs);
    if (token.isCancellationRequested) return undefined;

    const currentLinePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (!currentLinePrefix.trim() && position.character === 0) return undefined;

    try {
      const { prefix, suffix } = getDocumentContextAroundPosition(document, position);
      if (token.isCancellationRequested) return undefined;

      const response = await this.client.request<AutocompleteResponse>('POST', '/ide/autocomplete', {
        file: vscode.workspace.asRelativePath(document.uri),
        absolutePath: document.uri.fsPath,
        languageId: document.languageId,
        workspacePath: getWorkspacePath(),
        prefix,
        suffix,
        currentLine: currentLinePrefix,
        ...getDocumentSignals(document),
        ...getInlineCompletionContextLimits()
      });
      if (token.isCancellationRequested || !response.ok) {
        if (response.error) this.output.appendLine(`[autocomplete] ${response.error}`);
        return undefined;
      }

      const suggestion = cleanInlineSuggestion(response.suggestion || '');
      if (!suggestion) return undefined;
      if (response.id) {
        rememberInlineCompletion({
          id: response.id,
          uri: document.uri.toString(),
          offset: document.offsetAt(position),
          suggestion,
          offeredAt: Date.now(),
          latencyMs: response.latencyMs
        });
      }
      return [new vscode.InlineCompletionItem(suggestion, new vscode.Range(position, position))];
    } catch (error) {
      this.output.appendLine(`[autocomplete] ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}

class BlackHoleCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    _document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    if (!range.isEmpty) {
      const editAction = new vscode.CodeAction('BlackHole: Inline Edit Selection', vscode.CodeActionKind.RefactorRewrite);
      editAction.command = { command: 'blackhole.inlineEdit', title: 'BlackHole: Inline Edit Selection' };
      actions.push(editAction);
    }

    if (context.diagnostics.length > 0) {
      const fixAction = new vscode.CodeAction('BlackHole: Fix Diagnostics', vscode.CodeActionKind.QuickFix);
      fixAction.command = {
        command: 'blackhole.fixDiagnostics',
        title: 'BlackHole: Fix Diagnostics',
        arguments: [context.diagnostics]
      };
      actions.push(fixAction);
    }

    return actions;
  }
}

class BlackHoleCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.lineCount === 0) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(range, {
        title: '$(sparkle) BlackHole Inline Edit',
        command: 'blackhole.inlineEdit'
      }),
      new vscode.CodeLens(range, {
        title: '$(zap) BlackHole Complete Here',
        command: 'blackhole.generateCompletion'
      }),
      new vscode.CodeLens(range, {
        title: '$(diff) BlackHole Review Diffs',
        command: 'blackhole.reviewAgentDiffs'
      }),
      new vscode.CodeLens(range, {
        title: '$(rocket) BlackHole Run Agent Task',
        command: 'blackhole.runAgentTask'
      })
    ];

    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    if (diagnostics.length > 0) {
      lenses.push(new vscode.CodeLens(range, {
        title: `$(wrench) BlackHole Fix ${diagnostics.length} Diagnostic${diagnostics.length === 1 ? '' : 's'}`,
        command: 'blackhole.fixDiagnostics',
        arguments: [diagnostics]
      }));
    }

    return lenses;
  }
}

class BlackHoleSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private lastSelection?: SelectionPayload;
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: BlackHoleClient,
    private readonly output: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleWebviewMessage(message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.post({ type: 'append', level: 'error', text });
        vscode.window.showErrorMessage(text);
      }
    });

    this.postState();
    this.sendSelectionToWebview(getActiveSelection());
    void this.connect({ silent: true });
  }

  async connect({ silent }: { silent: boolean }) {
    try {
      const bootstrap = await this.client.connect();
      this.status.text = '$(circle-large-filled) BlackHole';
      this.status.tooltip = `Connected to ${bootstrap.baseUrl}`;
      this.post({ type: 'append', level: 'system', text: `Connected to ${bootstrap.baseUrl}` });
      this.postState();
      if (getConfiguration().get<boolean>('autoSyncWorkspace', true)) {
        await this.syncWorkspace({ silent: true });
      }
      if (!silent) vscode.window.showInformationMessage('BlackHole local agent connected.');
    } catch (error) {
      this.status.text = '$(circle-slash) BlackHole';
      this.status.tooltip = 'BlackHole API is not connected.';
      this.postState(error instanceof Error ? error.message : String(error));
      if (!silent) throw error;
    }
  }

  async syncWorkspace({ silent }: { silent: boolean }) {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      const message = 'Open a VS Code workspace folder before syncing BlackHole.';
      this.post({ type: 'append', level: 'warning', text: message });
      if (!silent) vscode.window.showWarningMessage(message);
      return;
    }

    const response = await this.client.request<{ path: string }>('POST', '/workspace', { path: workspacePath });
    this.post({ type: 'append', level: 'system', text: `Workspace synced: ${response.path}` });
    this.postState();
    if (!silent) vscode.window.showInformationMessage('BlackHole workspace synced with VS Code.');
  }

  async resumeLatestCheckpoint() {
    const prompt = 'Resume from the latest BlackHole checkpoint and continue the previous task.';
    await this.runChat('/chat/resume-checkpoint', { sessionId: 'latest', messages: [{ role: 'user', content: prompt }] }, prompt);
  }

  sendSelectionToWebview(selection?: SelectionPayload) {
    this.lastSelection = selection;
    this.post({ type: 'selection', selection });
  }

  prefillPrompt(text: string) {
    this.post({ type: 'prefill', text });
  }

  private async handleWebviewMessage(message: any) {
    switch (message?.type) {
      case 'connect':
        await this.connect({ silent: false });
        break;
      case 'syncWorkspace':
        await this.syncWorkspace({ silent: false });
        break;
      case 'sendPrompt':
        await this.sendPrompt(String(message.text || ''), !!message.includeSelection);
        break;
      case 'resumeLatest':
        await this.resumeLatestCheckpoint();
        break;
      case 'clear':
        this.messages = [];
        this.post({ type: 'clear' });
        break;
      case 'openOutput':
        this.output.show();
        break;
      case 'openBrowser':
        await vscode.env.openExternal(vscode.Uri.parse(this.client.baseUrl));
        break;
      case 'runTerminal':
        await this.runTerminal(String(message.command || ''));
        break;
      case 'insertSelectionPrompt':
        if (this.lastSelection) {
          this.prefillPrompt(formatSelectionForPrompt(this.lastSelection));
        }
        break;
      default:
        break;
    }
  }

  private async sendPrompt(rawText: string, includeSelection: boolean) {
    const text = rawText.trim();
    if (!text) return;

    const prompt = includeSelection && this.lastSelection
      ? `${text}\n\n${formatSelectionForPrompt(this.lastSelection)}`
      : text;

    const userMessage: ChatMessage = { role: 'user', content: prompt };
    this.messages.push(userMessage);
    this.post({ type: 'append', level: 'user', text: prompt });
    await this.runChat('/chat', { messages: this.messages }, prompt);
  }

  private async runChat(apiPath: string, body: unknown, userPromptForHistory: string) {
    if (this.busy) {
      this.post({ type: 'append', level: 'warning', text: 'BlackHole is already running a task.' });
      return;
    }

    this.busy = true;
    this.post({ type: 'busy', busy: true });
    let assistantText = '';
    let toolEventCount = 0;
    let lastStatus = '';
    let streamError = '';

    try {
      await this.client.stream(apiPath, body, (event) => {
        this.handleStreamEvent(event);
        if (event.type === 'chunk' && event.text) {
          assistantText += event.text;
        } else if (event.type === 'tool_start' || event.type === 'tool_end') {
          toolEventCount += 1;
        } else if (event.type === 'status' && event.status) {
          lastStatus = event.status;
        } else if (event.type === 'error' && event.error) {
          streamError = event.error;
        }
      });

      const cleaned = assistantText.trim();
      if (cleaned) {
        this.messages.push({ role: 'assistant', content: cleaned });
      } else {
        const fallback = buildEmptyChatFallback(toolEventCount, lastStatus, streamError);
        this.post({ type: 'append', level: 'assistant', text: fallback });
        this.messages.push({ role: 'assistant', content: fallback });
        if (userPromptForHistory && apiPath.includes('resume')) {
          this.messages.push({ role: 'user', content: userPromptForHistory });
        }
      }
    } finally {
      this.busy = false;
      this.post({ type: 'busy', busy: false });
    }
  }

  private async runTerminal(command: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    this.post({ type: 'append', level: 'system', text: `Terminal: ${trimmed}` });
    await this.client.stream('/terminal/run', { command: trimmed }, (event) => {
      if (event.type === 'output' && event.log) {
        this.post({ type: 'append', level: 'terminal', text: event.log });
      } else if (event.type === 'end') {
        this.post({ type: 'append', level: 'system', text: 'Terminal command finished.' });
      } else if (event.type === 'error') {
        this.post({ type: 'append', level: 'error', text: event.error || 'Terminal stream failed.' });
      }
    });
  }

  private handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case 'chunk':
        if (event.text) this.post({ type: 'append', level: 'assistant', text: event.text });
        break;
      case 'status':
        if (event.status) this.post({ type: 'append', level: 'status', text: event.status });
        break;
      case 'tool_start':
        this.post({ type: 'append', level: 'tool', text: `Tool started: ${event.tool || 'unknown'}` });
        break;
      case 'tool_end':
        this.post({ type: 'append', level: 'tool', text: `Tool finished: ${event.tool || 'unknown'}` });
        break;
      case 'terminal_log':
        if (event.log) this.post({ type: 'append', level: 'terminal', text: event.log });
        break;
      case 'state_change':
        if (event.state) this.post({ type: 'append', level: 'state', text: `State: ${event.state}` });
        break;
      case 'error':
        this.post({ type: 'append', level: 'error', text: event.error || 'BlackHole stream error.' });
        break;
      case 'end':
        this.post({ type: 'append', level: 'system', text: 'BlackHole task finished.' });
        break;
      default:
        break;
    }
  }

  private postState(error?: string) {
    this.post({
      type: 'state',
      connected: this.client.isConnected,
      baseUrl: this.client.baseUrl,
      workspacePath: getWorkspacePath(),
      error
    });
  }

  private post(payload: unknown) {
    this.view?.webview.postMessage(payload);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'singularity-icon.png'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BlackHole</title>
  <style>
    :root {
      --bg: #0b0d12;
      --panel: #11151d;
      --border: #253042;
      --text: #e7edf7;
      --muted: #92a0b5;
      --accent: #45b8ff;
      --ok: #5ee087;
      --warn: #f6c453;
      --err: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: var(--bg);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
    }
    .root { display: flex; flex-direction: column; height: 100vh; min-height: 0; }
    .header {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #0f131b;
    }
    .header img { width: 22px; height: 22px; }
    .title { font-weight: 700; }
    .subtitle { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    button {
      border: 1px solid var(--border);
      background: #151b25;
      color: var(--text);
      border-radius: 4px;
      padding: 6px 8px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { border-color: var(--accent); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .status {
      padding: 7px 10px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }
    .selection {
      display: none;
      margin: 8px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--panel);
      color: var(--muted);
      font-size: 11px;
    }
    .selection.visible { display: block; }
    .messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 10px 8px;
    }
    .msg {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
      background: var(--panel);
    }
    .msg.user { border-color: #34506f; }
    .msg.assistant { border-color: #264b34; }
    .msg.error { border-color: #6b2b2b; color: var(--err); }
    .msg.warning { border-color: #665123; color: var(--warn); }
    .msg.tool, .msg.state, .msg.status, .msg.system { color: var(--muted); font-size: 11px; }
    .msg.terminal { color: #b6e3ff; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    .composer {
      border-top: 1px solid var(--border);
      padding: 8px;
      background: #0f131b;
    }
    textarea {
      width: 100%;
      min-height: 84px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      color: var(--text);
      background: #080b10;
      font: inherit;
      line-height: 1.45;
      outline: none;
    }
    textarea:focus { border-color: var(--accent); }
    .composer-actions {
      display: flex;
      gap: 6px;
      margin-top: 6px;
      align-items: center;
    }
    .composer-actions button.primary {
      background: #12324a;
      border-color: #245d83;
      flex: 1;
    }
    label { color: var(--muted); font-size: 11px; display: flex; align-items: center; gap: 4px; }
    input[type="checkbox"] { margin: 0; }
  </style>
</head>
<body>
  <div class="root">
    <div class="header">
      <img src="${iconUri}" alt="">
      <div>
        <div class="title">BlackHole Agent</div>
        <div class="subtitle" id="baseUrl">Disconnected</div>
      </div>
    </div>
    <div class="toolbar">
      <button id="connect">Connect</button>
      <button id="sync">Sync Workspace</button>
      <button id="resume">Resume</button>
      <button id="openOutput">Logs</button>
    </div>
    <div class="status" id="status">Start the BlackHole desktop app, then connect.</div>
    <div class="selection" id="selection"></div>
    <div class="messages" id="messages"></div>
    <div class="composer">
      <textarea id="prompt" placeholder="Ask BlackHole to inspect, edit, test, or explain the current workspace."></textarea>
      <div class="composer-actions">
        <button id="send" class="primary">Send</button>
        <button id="insertSelection">Selection</button>
        <button id="clear">Clear</button>
      </div>
      <div class="composer-actions">
        <label><input id="includeSelection" type="checkbox"> include selected code</label>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const status = document.getElementById('status');
    const baseUrl = document.getElementById('baseUrl');
    const selection = document.getElementById('selection');
    const prompt = document.getElementById('prompt');
    const includeSelection = document.getElementById('includeSelection');
    const send = document.getElementById('send');
    let busy = false;
    let selectedCode = null;

    function post(type, payload = {}) {
      vscode.postMessage({ type, ...payload });
    }

    function append(level, text) {
      if (!text) return;
      const el = document.createElement('div');
      el.className = 'msg ' + (level || 'system');
      el.textContent = text;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    }

    function setBusy(nextBusy) {
      busy = nextBusy;
      send.disabled = busy;
      send.textContent = busy ? 'Running...' : 'Send';
    }

    document.getElementById('connect').addEventListener('click', () => post('connect'));
    document.getElementById('sync').addEventListener('click', () => post('syncWorkspace'));
    document.getElementById('resume').addEventListener('click', () => post('resumeLatest'));
    document.getElementById('openOutput').addEventListener('click', () => post('openOutput'));
    document.getElementById('clear').addEventListener('click', () => {
      messages.textContent = '';
      post('clear');
    });
    document.getElementById('insertSelection').addEventListener('click', () => post('insertSelectionPrompt'));
    send.addEventListener('click', () => {
      post('sendPrompt', { text: prompt.value, includeSelection: includeSelection.checked });
      prompt.value = '';
    });
    prompt.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        send.click();
      }
    });

    window.addEventListener('message', event => {
      const message = event.data || {};
      if (message.type === 'state') {
        baseUrl.textContent = message.connected ? message.baseUrl : 'Disconnected';
        status.textContent = message.error || (message.workspacePath ? 'Workspace: ' + message.workspacePath : 'No workspace folder is open.');
      }
      if (message.type === 'selection') {
        selectedCode = message.selection || null;
        if (selectedCode) {
          selection.classList.add('visible');
          selection.textContent = selectedCode.file + ':' + selectedCode.startLine + '-' + selectedCode.endLine;
          includeSelection.checked = true;
        } else {
          selection.classList.remove('visible');
          selection.textContent = '';
          includeSelection.checked = false;
        }
      }
      if (message.type === 'prefill') {
        prompt.value = message.text || '';
        prompt.focus();
      }
      if (message.type === 'append') append(message.level, message.text);
      if (message.type === 'busy') setBusy(!!message.busy);
      if (message.type === 'clear') messages.textContent = '';
    });
  </script>
</body>
</html>`;
  }
}

async function runInlineEdit(client: BlackHoleClient, output: vscode.OutputChannel, providedInstruction?: string, providedRange?: vscode.Range) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a file before running BlackHole inline edit.');
    return;
  }

  const targetRange = normalizeEditRange(editor.document, providedRange || editor.selection);
  if (!targetRange || targetRange.isEmpty) {
    vscode.window.showWarningMessage('Select code before running BlackHole inline edit.');
    return;
  }

  const instruction = providedInstruction || await vscode.window.showInputBox({
    title: 'BlackHole Inline Edit',
    prompt: 'Describe how BlackHole should rewrite the selected code.',
    placeHolder: 'Example: simplify this function and keep the same behavior'
  });
  if (!instruction?.trim()) return;

  const selectedCode = editor.document.getText(targetRange);
  if (!selectedCode.trim()) {
    vscode.window.showWarningMessage('The selected range does not contain code.');
    return;
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'BlackHole is editing the selected code...',
    cancellable: false
  }, async () => {
    try {
      const response = await client.request<InlineEditResponse>('POST', '/ide/inline-edit', {
        file: vscode.workspace.asRelativePath(editor.document.uri),
        absolutePath: editor.document.uri.fsPath,
        languageId: editor.document.languageId,
        workspacePath: getWorkspacePath(),
        selection: selectedCode,
        instruction: instruction.trim(),
        startLine: targetRange.start.line + 1,
        endLine: targetRange.end.line + 1
      });

      if (!response.ok || !response.replacement) {
        const message = response.error || 'BlackHole did not return replacement code.';
        output.appendLine(`[inline-edit] ${message}`);
        vscode.window.showWarningMessage(message);
        return;
      }

      const replacement = normalizeReplacementForRange(response.replacement, selectedCode);
      const applied = await editor.edit(builder => {
        builder.replace(targetRange, replacement);
      });
      if (applied) {
        vscode.window.showInformationMessage('BlackHole inline edit applied.');
      } else {
        vscode.window.showErrorMessage('VS Code rejected the BlackHole inline edit.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[inline-edit] ${message}`);
      vscode.window.showErrorMessage(message);
    }
  });
}

async function runFixDiagnostics(client: BlackHoleClient, output: vscode.OutputChannel, providedDiagnostics?: vscode.Diagnostic[]) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a file before asking BlackHole to fix diagnostics.');
    return;
  }

  const allDiagnostics = providedDiagnostics?.length
    ? providedDiagnostics
    : vscode.languages.getDiagnostics(editor.document.uri);
  const selectedRange = editor.selection && !editor.selection.isEmpty ? editor.selection : undefined;
  const diagnostics = selectedRange
    ? allDiagnostics.filter(diagnostic => rangesIntersect(selectedRange, diagnostic.range))
    : allDiagnostics;

  if (diagnostics.length === 0) {
    vscode.window.showWarningMessage('No diagnostics are available for BlackHole to fix.');
    return;
  }

  const targetRange = rangeFromDiagnostics(editor.document, diagnostics);
  const instruction = [
    'Fix the following VS Code diagnostics in the selected code.',
    'Keep unrelated behavior unchanged.',
    '',
    ...diagnostics.slice(0, 12).map((diagnostic, index) => {
      const line = diagnostic.range.start.line + 1;
      const source = diagnostic.source ? ` (${diagnostic.source})` : '';
      return `${index + 1}. Line ${line}${source}: ${diagnostic.message}`;
    })
  ].join('\n');

  await runInlineEdit(client, output, instruction, targetRange);
}

async function runManualCompletion(client: BlackHoleClient, output: vscode.OutputChannel) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a file before generating a BlackHole completion.');
    return;
  }

  const position = editor.selection.active;
  try {
    const { prefix, suffix } = getDocumentContextAroundPosition(editor.document, position);
    const response = await client.request<AutocompleteResponse>('POST', '/ide/autocomplete', {
      file: vscode.workspace.asRelativePath(editor.document.uri),
      absolutePath: editor.document.uri.fsPath,
      languageId: editor.document.languageId,
      workspacePath: getWorkspacePath(),
      prefix,
      suffix,
      currentLine: editor.document.lineAt(position.line).text.slice(0, position.character),
      ...getDocumentSignals(editor.document),
      ...getInlineCompletionContextLimits()
    });
    if (!response.ok || !response.suggestion) {
      const message = response.error || 'BlackHole did not return a completion.';
      output.appendLine(`[manual-completion] ${message}`);
      vscode.window.showWarningMessage(message);
      return;
    }

    const suggestion = cleanInlineSuggestion(response.suggestion);
    if (!suggestion) {
      vscode.window.showWarningMessage('BlackHole returned an empty completion.');
      return;
    }

    const inserted = await editor.edit(builder => {
      builder.insert(position, suggestion);
    });
    if (inserted) {
      if (response.id) {
        reportAutocompleteFeedback(client, output, {
          id: response.id,
          accepted: true,
          insertedText: suggestion,
          latencyMs: response.latencyMs
        });
      }
      vscode.window.showInformationMessage('BlackHole completion inserted.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[manual-completion] ${message}`);
    vscode.window.showErrorMessage(message);
  }
}

async function runDiffReview(client: BlackHoleClient, output: vscode.OutputChannel, providedTransactionId?: string) {
  try {
    const transaction = providedTransactionId
      ? await getTransactionById(client, providedTransactionId)
      : await pickDiffTransaction(client, 'Review BlackHole Agent Diff');
    if (!transaction) return;
    await showTransactionDiff(transaction);

    if (!providedTransactionId) {
      const actions = getTransactionActions(transaction);
      if (actions.length === 0) return;
      const picked = await vscode.window.showQuickPick(actions, {
        placeHolder: `Choose an action for ${transaction.id}`
      });
      if (picked) {
        await runDiffTransactionAction(client, output, picked.action, transaction.id);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[diff-review] ${message}`);
    vscode.window.showErrorMessage(message);
  }
}

async function runDiffTransactionAction(
  client: BlackHoleClient,
  output: vscode.OutputChannel,
  action: 'accept' | 'reject' | 'rollback',
  providedTransactionId?: string
) {
  try {
    const transaction = providedTransactionId
      ? await getTransactionById(client, providedTransactionId)
      : await pickDiffTransaction(client, `BlackHole Diff: ${titleCase(action)}`, action);
    if (!transaction) return;

    const response = await client.request<DiffTransactionResponse>(
      'POST',
      `/diff/transactions/${encodeURIComponent(transaction.id)}/${action}`
    );
    const nextTransaction = response.transaction;
    vscode.window.showInformationMessage(`BlackHole diff ${action} completed: ${nextTransaction.status}`);
    if (action === 'accept' || action === 'rollback') {
      try {
        await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      } catch {
        // Some extension-host test environments do not expose the explorer refresh command.
      }
    }
    await showTransactionDiff(nextTransaction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[diff-${action}] ${message}`);
    vscode.window.showErrorMessage(message);
  }
}

async function runAgentTask(
  client: BlackHoleClient,
  output: vscode.OutputChannel,
  options: { prompt?: string; includeSelection?: boolean } = {}
) {
  const rawPrompt = options.prompt || await vscode.window.showInputBox({
    title: 'BlackHole Agent Task',
    prompt: 'Describe the coding task BlackHole should run against the current workspace.',
    placeHolder: 'Example: inspect this bug, patch the relevant files, and run targeted verification'
  });
  if (!rawPrompt?.trim()) return;

  const selection = options.includeSelection ? getActiveSelection() : undefined;
  if (options.includeSelection && !selection) {
    vscode.window.showWarningMessage('No active selection was found. BlackHole will run with the prompt only.');
  }

  const prompt = selection
    ? `${rawPrompt.trim()}\n\n${formatSelectionForPrompt(selection)}`
    : rawPrompt.trim();

  output.show(true);
  output.appendLine(`[agent] Starting task: ${rawPrompt.trim()}`);

  const beforeTransactions = await safeFetchDiffTransactions(client, output);
  const beforeIds = new Set(beforeTransactions.map(transaction => transaction.id));
  let assistantText = '';

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'BlackHole agent is running...',
    cancellable: false
  }, async (progress) => {
    await syncWorkspaceForAgent(client, output);
    await client.stream('/chat', { messages: [{ role: 'user', content: prompt }] }, (event) => {
      const line = formatAgentStreamEvent(event);
      if (line) output.appendLine(line);
      if (event.type === 'chunk' && event.text) {
        assistantText += event.text;
        progress.report({ message: compactStatusText(event.text) });
      } else if (event.type === 'status' && event.status) {
        progress.report({ message: compactStatusText(event.status) });
      } else if (event.type === 'tool_start' && event.tool) {
        progress.report({ message: `Tool: ${event.tool}` });
      }
    });
  });

  const afterTransactions = await safeFetchDiffTransactions(client, output);
  const newTransactions = afterTransactions.filter(transaction => !beforeIds.has(transaction.id));
  const reviewable = newTransactions.find(transaction => ['reviewed', 'review_failed', 'accepted'].includes(transaction.status));
  const summary = assistantText.trim()
    ? compactStatusText(assistantText.trim())
    : 'BlackHole agent task finished.';

  if (reviewable) {
    const choice = await vscode.window.showInformationMessage(
      `BlackHole task finished with a new diff: ${reviewable.status}`,
      'Review Diffs'
    );
    if (choice === 'Review Diffs') {
      await runDiffReview(client, output, reviewable.id);
    }
    return;
  }

  vscode.window.showInformationMessage(summary);
}

async function syncWorkspaceForAgent(client: BlackHoleClient, output: vscode.OutputChannel) {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    output.appendLine('[agent] No VS Code workspace folder is open; skipping workspace sync.');
    return;
  }
  try {
    await client.request<{ path: string }>('POST', '/workspace', { path: workspacePath });
    output.appendLine(`[agent] Workspace synced: ${workspacePath}`);
  } catch (error) {
    output.appendLine(`[agent] Workspace sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function safeFetchDiffTransactions(client: BlackHoleClient, output: vscode.OutputChannel) {
  try {
    return await fetchDiffTransactions(client);
  } catch (error) {
    output.appendLine(`[diff] Could not fetch transactions: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function fetchDiffTransactions(client: BlackHoleClient) {
  const response = await client.request<DiffTransactionsResponse>('GET', '/diff/transactions?limit=30');
  return response.transactions || [];
}

async function getTransactionById(client: BlackHoleClient, transactionId: string) {
  const transactions = await fetchDiffTransactions(client);
  const transaction = transactions.find(item => item.id === transactionId);
  if (!transaction) {
    throw new Error(`BlackHole diff transaction not found: ${transactionId}`);
  }
  return transaction;
}

async function pickDiffTransaction(client: BlackHoleClient, title: string, action?: 'accept' | 'reject' | 'rollback') {
  const transactions = filterTransactionsForAction(await fetchDiffTransactions(client), action);
  if (transactions.length === 0) {
    vscode.window.showWarningMessage('No BlackHole diff transactions are available.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(transactions.map(transaction => ({
    label: `${statusIcon(transaction.status)} ${transaction.status}  ${transaction.id}`,
    description: formatTransactionFiles(transaction),
    detail: transaction.updatedAt || transaction.createdAt || '',
    transaction
  })), { title, placeHolder: 'Select a BlackHole diff transaction' });

  return picked?.transaction;
}

function filterTransactionsForAction(transactions: PatchTransaction[], action?: 'accept' | 'reject' | 'rollback') {
  if (action === 'accept') return transactions.filter(transaction => transaction.status === 'reviewed');
  if (action === 'reject') return transactions.filter(transaction => ['reviewed', 'review_failed'].includes(transaction.status));
  if (action === 'rollback') return transactions.filter(transaction => transaction.status === 'accepted');
  return transactions;
}

async function showTransactionDiff(transaction: PatchTransaction) {
  const content = buildTransactionDiffDocument(transaction);
  const document = await vscode.workspace.openTextDocument({
    language: 'diff',
    content
  });
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

function buildTransactionDiffDocument(transaction: PatchTransaction) {
  const previews = getTransactionPreviews(transaction);
  const header = [
    `# BlackHole Diff Transaction`,
    `# ID: ${transaction.id}`,
    `# Status: ${transaction.status}`,
    `# Workspace: ${transaction.workspaceRoot || getWorkspacePath() || 'unknown'}`,
    `# Updated: ${transaction.updatedAt || transaction.createdAt || 'unknown'}`,
    `# Files: ${formatTransactionFiles(transaction) || 'none'}`,
    ''
  ].join('\n');

  if (previews.length === 0) {
    return `${header}# No diff preview is available for this transaction.\n`;
  }

  return `${header}${previews.map(preview => {
    if (!preview.ok) {
      return [
        `# ${preview.path || 'unknown'} (${preview.type || 'operation'})`,
        `# ERROR: ${preview.error || 'preview failed'}`,
        ''
      ].join('\n');
    }
    return preview.diff || `# ${preview.path || 'unknown'} changed, but no diff payload was stored.\n`;
  }).join('\n')}`;
}

function getTransactionPreviews(transaction: PatchTransaction) {
  return transaction.applyResult?.previews
    || transaction.review?.previews
    || [];
}

function getTransactionActions(transaction: PatchTransaction) {
  const actions: Array<{ label: string; action: 'accept' | 'reject' | 'rollback' }> = [];
  if (transaction.status === 'reviewed') {
    actions.push({ label: '$(check) Accept Diff', action: 'accept' });
    actions.push({ label: '$(close) Reject Diff', action: 'reject' });
  }
  if (transaction.status === 'review_failed') {
    actions.push({ label: '$(close) Reject Failed Review', action: 'reject' });
  }
  if (transaction.status === 'accepted') {
    actions.push({ label: '$(history) Rollback Accepted Diff', action: 'rollback' });
  }
  return actions;
}

function formatTransactionFiles(transaction: PatchTransaction) {
  const files = transaction.applyResult?.changedFiles
    || transaction.review?.changedFiles
    || transaction.rollbackResult?.changedFiles
    || [];
  return files.slice(0, 5).join(', ') + (files.length > 5 ? ` +${files.length - 5}` : '');
}

// P1-6: thin wrappers over ./textUtils (behavior unchanged).
function statusIcon(status: string) { return statusIconPure(status); }
function titleCase(value: string) { return titleCasePure(value); }
function formatAgentStreamEvent(event: StreamEvent) { return formatAgentStreamEventPure(event); }
function buildEmptyChatFallback(toolEventCount: number, lastStatus: string, streamError: string) {
  return buildEmptyChatFallbackPure(toolEventCount, lastStatus, streamError);
}
function compactStatusText(value: string) { return compactStatusTextPure(value); }

function getConfiguration() {
  return vscode.workspace.getConfiguration('blackhole');
}

function getConfiguredBaseUrl() {
  const configured = getConfiguration().get<string>('apiBaseUrl', 'http://127.0.0.1:3003');
  return String(configured || 'http://127.0.0.1:3003').replace(/\/+$/, '');
}

function getCandidateBaseUrls() {
  // P1-6: pure helper in ./textUtils (port-scan range unchanged).
  return getCandidateBaseUrlsFrom(getConfiguredBaseUrl());
}

function getWorkspacePath() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function getActiveSelection() {
  const editor = vscode.window.activeTextEditor;
  return editor ? getSelectionFromEditor(editor) : undefined;
}

function getSelectionFromEditor(editor: vscode.TextEditor): SelectionPayload | undefined {
  const selection = editor.selection;
  if (!selection || selection.isEmpty) return undefined;
  const code = editor.document.getText(selection);
  if (!code.trim()) return undefined;
  return {
    file: vscode.workspace.asRelativePath(editor.document.uri),
    absolutePath: editor.document.uri.fsPath,
    code,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1
  };
}

function formatSelectionForPrompt(selection: SelectionPayload) {
  return [
    '[VS Code Selection]',
    `File: ${selection.file}`,
    `Path: ${selection.absolutePath}`,
    `Lines: ${selection.startLine}-${selection.endLine}`,
    '```',
    selection.code,
    '```'
  ].join('\n');
}

function getDocumentContextAroundPosition(document: vscode.TextDocument, position: vscode.Position) {
  const config = getConfiguration();
  const maxPrefixChars = Math.max(500, config.get<number>('inlineCompletions.maxPrefixChars', 5000));
  const maxSuffixChars = Math.max(250, config.get<number>('inlineCompletions.maxSuffixChars', 2000));
  const offset = document.offsetAt(position);
  const prefixStart = document.positionAt(Math.max(0, offset - maxPrefixChars));
  const suffixEnd = document.positionAt(Math.min(document.getText().length, offset + maxSuffixChars));
  return {
    prefix: document.getText(new vscode.Range(prefixStart, position)),
    suffix: document.getText(new vscode.Range(position, suffixEnd))
  };
}

function getInlineCompletionContextLimits() {
  const config = getConfiguration();
  return {
    maxPrefixChars: Math.max(500, config.get<number>('inlineCompletions.maxPrefixChars', 5000)),
    maxSuffixChars: Math.max(250, config.get<number>('inlineCompletions.maxSuffixChars', 2000))
  };
}

function getDocumentSignals(document: vscode.TextDocument) {
  const text = document.getText().slice(0, 300_000);
  const imports = new Set<string>();
  const symbols = new Set<string>();
  for (const line of text.split(/\r?\n/).slice(0, 500)) {
    const trimmed = line.trim();
    if (/^(import\s+.+|export\s+.+\s+from\s+['"].+['"];?|const\s+\w+\s*=\s*require\()/.test(trimmed)) {
      imports.add(trimmed.slice(0, 220));
    } else if (/^(from\s+\S+\s+import\s+.+|import\s+\S+)/.test(trimmed)) {
      imports.add(trimmed.slice(0, 220));
    }
  }

  const language = document.languageId.toLowerCase();
  const patterns = language.includes('python')
    ? [
      /\b(?:async\s+def|def)\s+([A-Za-z_][\w]*)\s*\(/g,
      /\bclass\s+([A-Za-z_][\w]*)\s*[:(]/g
    ]
    : [
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
      /\b(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/g,
      /\b(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{;]/g
    ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && symbols.size < 120) {
      symbols.add(match[1]);
    }
  }

  return {
    imports: Array.from(imports).slice(0, 40),
    symbols: Array.from(symbols).slice(0, 120)
  };
}

function rememberInlineCompletion(completion: PendingInlineCompletion) {
  pendingInlineCompletions.set(completion.id, completion);
  for (const [id, item] of pendingInlineCompletions.entries()) {
    if (Date.now() - item.offeredAt > INLINE_COMPLETION_FEEDBACK_TIMEOUT_MS) {
      pendingInlineCompletions.delete(id);
    }
  }
  while (pendingInlineCompletions.size > 80) {
    const firstKey = pendingInlineCompletions.keys().next().value;
    if (!firstKey) break;
    pendingInlineCompletions.delete(firstKey);
  }
}

function reportInlineCompletionAcceptance(
  client: BlackHoleClient,
  output: vscode.OutputChannel,
  event: vscode.TextDocumentChangeEvent
) {
  if (event.contentChanges.length === 0) return;
  const uri = event.document.uri.toString();
  const now = Date.now();
  for (const [id, completion] of Array.from(pendingInlineCompletions.entries())) {
    if (completion.uri !== uri) continue;
    if (now - completion.offeredAt > INLINE_COMPLETION_FEEDBACK_TIMEOUT_MS) {
      pendingInlineCompletions.delete(id);
      reportAutocompleteFeedback(client, output, {
        id,
        accepted: false,
        latencyMs: now - completion.offeredAt
      });
      continue;
    }

    for (const change of event.contentChanges) {
      if (!looksLikeAcceptedCompletion(change, completion)) continue;
      pendingInlineCompletions.delete(id);
      reportAutocompleteFeedback(client, output, {
        id,
        accepted: true,
        insertedText: change.text,
        latencyMs: now - completion.offeredAt
      });
      break;
    }
  }
}

function expireInlineCompletionFeedback(client: BlackHoleClient, output: vscode.OutputChannel) {
  const now = Date.now();
  for (const [id, completion] of Array.from(pendingInlineCompletions.entries())) {
    if (now - completion.offeredAt <= INLINE_COMPLETION_FEEDBACK_TIMEOUT_MS) continue;
    pendingInlineCompletions.delete(id);
    reportAutocompleteFeedback(client, output, {
      id,
      accepted: false,
      latencyMs: now - completion.offeredAt
    });
  }
}

function looksLikeAcceptedCompletion(change: vscode.TextDocumentContentChangeEvent, completion: PendingInlineCompletion) {
  const inserted = change.text.replace(/\r\n/g, '\n');
  if (!inserted.trim()) return false;
  if (Math.abs(change.rangeOffset - completion.offset) > 2) return false;
  const suggestion = completion.suggestion.replace(/\r\n/g, '\n');
  const significantPrefix = suggestion.trimStart().slice(0, Math.min(24, Math.max(8, suggestion.trimStart().length)));
  return suggestion.startsWith(inserted)
    || inserted.startsWith(suggestion)
    || (!!significantPrefix && inserted.includes(significantPrefix));
}

function reportAutocompleteFeedback(
  client: BlackHoleClient,
  output: vscode.OutputChannel,
  payload: { id: string; accepted: boolean; insertedText?: string; latencyMs?: number }
) {
  client.request('POST', '/ide/autocomplete/feedback', payload).catch(error => {
    output.appendLine(`[autocomplete-feedback] ${error instanceof Error ? error.message : String(error)}`);
  });
}

// P1-6: thin wrappers over ./textUtils (behavior unchanged).
function cleanInlineSuggestion(raw: string) { return cleanInlineSuggestionPure(raw); }
function normalizeReplacementForRange(raw: string, selectedCode: string) {
  return normalizeReplacementForRangePure(raw, selectedCode);
}
function stripMarkdownCodeFence(raw: string) { return stripMarkdownCodeFencePure(raw); }

function normalizeEditRange(document: vscode.TextDocument, range: vscode.Range | vscode.Selection | undefined) {
  if (!range) return undefined;
  const normalized = new vscode.Range(range.start, range.end);
  if (!normalized.isEmpty) return normalized;
  const line = Math.min(Math.max(normalized.start.line, 0), document.lineCount - 1);
  return document.lineAt(line).range;
}

function rangeFromDiagnostics(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
  const startLine = Math.max(0, Math.min(...diagnostics.map(diagnostic => diagnostic.range.start.line)));
  const endLine = Math.min(document.lineCount - 1, Math.max(...diagnostics.map(diagnostic => diagnostic.range.end.line)));
  return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character);
}

function rangesIntersect(left: vscode.Range, right: vscode.Range) {
  return left.intersection(right) !== undefined;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
  return clampNumberPure(value, min, max, fallback);
}

function requestJson<T>(method: string, urlText: string, body?: unknown, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(token ? { 'x-blackhole-token': token } : {})
      }
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 0) >= 400) {
          reject(new Error(parseErrorMessage(data) || `HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data || '{}') as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(8000, () => {
      request.destroy(new Error('request timed out'));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function streamSse(urlText: string, body: unknown, token: string, onEvent: (event: StreamEvent) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const payload = JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-blackhole-token': token
      }
    }, response => {
      if ((response.statusCode || 0) >= 400) {
        let errorBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { errorBody += chunk; });
        response.on('end', () => reject(new Error(parseErrorMessage(errorBody) || `HTTP ${response.statusCode}`)));
        return;
      }

      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', chunk => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const dataLine = part.split('\n').find(line => line.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6).trim();
          if (!json || json === '[DONE]') continue;
          try {
            onEvent(JSON.parse(json));
          } catch {
            // Ignore malformed partial events.
          }
        }
      });
      response.on('end', () => {
        onEvent({ type: 'end' });
        resolve();
      });
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

function parseErrorMessage(body: string) {
  try {
    const parsed = JSON.parse(body || '{}');
    return parsed.error || parsed.message || '';
  } catch {
    return body.trim();
  }
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export function deactivate() {}
