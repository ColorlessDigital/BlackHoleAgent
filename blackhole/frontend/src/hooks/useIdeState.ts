import { useState } from 'react';
import type { ApiClient, AppendTerminal, IdeEntry } from '../types.ts';

export default function useIdeState(
  client: ApiClient | null,
  appendTerminal: AppendTerminal | undefined
) {
  const [detectedIdes, setDetectedIdes] = useState<Record<string, IdeEntry> | null>(null);
  const [isDetectingIdes, setIsDetectingIdes] = useState(false);
  const [selectedLaunchIde, setSelectedLaunchIde] = useState('vscode');
  const [isLaunchingIde, setIsLaunchingIde] = useState(false);

  async function detectInstalledIdes(): Promise<void> {
    if (!client) return;
    setIsDetectingIdes(true);
    try {
      const data = await client.request('/ide/detect');
      if (data.success) {
        setDetectedIdes(data.ides);
        appendTerminal?.('IDE detection completed.', 'success');
      } else {
        appendTerminal?.('IDE detection failed.', 'error');
      }
    } catch (error) {
      appendTerminal?.(`IDE detection request failed: ${(error as Error).message}`, 'error');
    } finally {
      setIsDetectingIdes(false);
    }
  }

  async function integrateAndLaunchIde(): Promise<void> {
    if (!client) return;
    if (!detectedIdes) {
      appendTerminal?.('Run IDE detection first.', 'warning');
      return;
    }

    const currentIdeInfo = detectedIdes[selectedLaunchIde];
    if (!currentIdeInfo?.detected) {
      appendTerminal?.(`Selected IDE is not detected: ${selectedLaunchIde.toUpperCase()}`, 'error');
      return;
    }

    setIsLaunchingIde(true);
    appendTerminal?.(`Preparing ${selectedLaunchIde.toUpperCase()} integration...`, 'log');

    try {
      const data = await client.request('/ide/integrate-launch', {
        method: 'POST',
        body: JSON.stringify({
          ideType: selectedLaunchIde,
          exePath: currentIdeInfo.path
        })
      });
      if (data.success) {
        appendTerminal?.(data.message || 'IDE integration completed.', 'success');
        if (data.extensionPath) {
          appendTerminal?.(`VS Code extension path: ${data.extensionPath}`, 'success');
        }
      } else {
        appendTerminal?.(`IDE launch failed: ${data.error || 'unknown error'}`, 'error');
      }
    } catch (error) {
      appendTerminal?.(`IDE integration request failed: ${(error as Error).message}`, 'error');
    } finally {
      setIsLaunchingIde(false);
    }
  }

  return {
    detectedIdes, setDetectedIdes,
    isDetectingIdes, setIsDetectingIdes,
    selectedLaunchIde, setSelectedLaunchIde,
    isLaunchingIde, setIsLaunchingIde,
    detectInstalledIdes, integrateAndLaunchIde
  };
}
