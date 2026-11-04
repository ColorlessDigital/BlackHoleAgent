import React from 'react';
import useAppState from './hooks/useAppState';
import FileExplorer from './components/FileExplorer';
import CodeSandbox from './components/CodeSandbox';
import TerminalPanel from './components/TerminalPanel';
import SettingsModal from './components/SettingsModal';
import SecurityGate from './components/SecurityGate';
import ChatPanel from './components/ChatPanel';
import ProductModeRail from './components/ProductModeRail';
import OperationalPanel from './components/OperationalPanel';

const RIGHT_TABS = [
  { id: 'code', labelKey: 'sandboxTab' },
  { id: 'setup', labelKey: 'setupTab' },
  { id: 'review', labelKey: 'reviewTab' },
  { id: 'reports', labelKey: 'reportsTab' },
  { id: 'ci', labelKey: 'ciTab' }
];

// Electron frameless-window drag region (not part of React CSS types).
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export default function App() {
  const {
    client,
    locale, t, handleLangChange,
    workspacePath, handleChangeWorkspace,
    activeTab, setActiveTab,
    activeBrainTab, setActiveBrainTab,
    isSidebarCollapsed, setIsSidebarCollapsed,
    isRightPanelCollapsed, setIsRightPanelCollapsed,
    sidebarWidth, setSidebarWidth, isResizingSidebar, setIsResizingSidebar,
    rightPanelWidth, setRightPanelWidth, isResizingRightPanel, setIsResizingRightPanel,
    bottomPanelHeight, setBottomPanelHeight, isResizingBottomPanel, setIsResizingBottomPanel,
    isOpenSettingsModal, setIsOpenSettingsModal,
    settingsActiveTab, setSettingsActiveTab,
    detectedIdes, isDetectingIdes, detectInstalledIdes,
    selectedLaunchIde, setSelectedLaunchIde,
    isLaunchingIde, integrateAndLaunchIde,
    attachments, setAttachments,
    showAttachmentMenu, setShowAttachmentMenu,
    handleFileAttachment, removeAttachment,
    attachmentMenuRef,
    files, selectedFile, selectedFileContent, expandedFolders,
    toggleFolder, selectFile, fetchFiles, rootNextOffset, rootLoading, fileTreeError, loadMoreFiles,
    messages, input, setInput,
    isThinking, statusMessage, elapsedSeconds, lastSignalAgeSeconds, statusHistory, recoveryInfo, activeTool,
    handleSendMessage, handleStopGeneration, handleResumeWithOutputLimit,
    chatEndRef,
    savedSessions, currentSessionId,
    handleNewSession, handleSelectSession, handleSaveSession, handleDeleteSession,
    terminalLines, setTerminalLines, terminalEndRef,
    runtimeStatus, runtimeDiscovery, isRuntimeStarting, isRuntimeStopping,
    handleStartLlamaRuntime, handleStopLlamaRuntime,
    handleSelectLlamaServerFile, handleSelectGgufFile,
    config, setConfig, settingsStatus, webTestStatus, handleWebTestConnection,
    localModels, localModelError, isLocalModelLoading, fetchLocalModels,
    handleSaveSettings, handleAddMemory, handleDeleteMemory,
    preflightResult, isPreflightLoading, handleRunPreflight,
    collabTopic, setCollabTopic,
    collabAgents, setCollabAgents,
    collabMessages, setCollabMessages, isCollaborating, activeCollabAgent,
    handleStartCollaboration, handleStopCollaboration,
    pendingSecurityAction, handleRespondSecurity,
    tasks, toggleTaskStatus, newTaskInput, setNewTaskInput, handleAddTask,
    newMemoryInput, setNewMemoryInput,
    modelCatalog, handleSelectModel, activeModelServer,
    handleTestOpengo, opengoTest, isOpengoTesting, fetchModelCatalog,
    goTest, setGoTest, isGoTesting, isGoDiscovering, goDiscoveryError,
    handleTestGo, handleDiscoverGo, handleUseGo, handleClearGoKey,
    isCompressing, contextEstimate, handleCompressContext,
    agentTimeline,
    checkpoints,
    latestCheckpoint,
    checkpointStatus,
    fetchAgentCheckpoints,
    handleLoadLatestCheckpoint,
    handleResumeLatestCheckpoint
  } = useAppState();

  const [productMode, setProductMode] = React.useState('agent');
  const isColumnResizing = isResizingSidebar || isResizingRightPanel;
  const isRowResizing = isResizingBottomPanel;

  const startResize = (event: React.PointerEvent, setter: (resizing: boolean) => void) => {
    event.preventDefault();
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    setter(true);
  };

  React.useEffect(() => {
    if (activeTab === 'explorer') {
      setActiveTab('code');
    }
  }, [activeTab, setActiveTab]);

  const sendWindowCommand = (command: string) => {
    if (window.blackhole?.[command as keyof typeof window.blackhole]) {
      (window.blackhole[command as keyof typeof window.blackhole] as (() => void) | undefined)?.();
      return;
    }
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send(`window-${command}`);
      return;
    }
    if (command === 'close') {
      window.close();
    }
  };

  const renderRightPanel = () => {
    if (activeTab === 'code') {
      return (
        <CodeSandbox
          selectedFile={selectedFile}
          selectedFileContent={selectedFileContent}
          t={t}
        />
      );
    }

    return (
      <OperationalPanel
        view={activeTab}
        client={client}
        workspacePath={workspacePath}
        config={config}
        runtimeStatus={runtimeStatus}
        runtimeDiscovery={runtimeDiscovery}
        setIsOpenSettingsModal={setIsOpenSettingsModal}
        setSettingsActiveTab={setSettingsActiveTab}
        handleRunPreflight={handleRunPreflight}
        handleStartLlamaRuntime={handleStartLlamaRuntime}
        handleSelectGgufFile={handleSelectGgufFile}
        detectInstalledIdes={detectInstalledIdes}
        integrateAndLaunchIde={integrateAndLaunchIde}
        fetchFiles={fetchFiles}
        locale={locale}
        t={t}
      />
    );
  };

  return (
    <>
      <div className="titlebar">
        <div className="titlebar-logo">
          <button
            className="sidebar-toggle-btn"
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
            title={isSidebarCollapsed ? t('openSidebar') : t('closeSidebar')}
            type="button"
            style={{
              ...NO_DRAG,
              background: 'transparent',
              border: 'none',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: 16,
              marginRight: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
              borderRadius: 4
            }}
          >
            {isSidebarCollapsed ? '>' : '<'}
          </button>
          <div className="titlebar-singularity" />
          <span>{t('appName')}</span>
          <span className="titlebar-creator">{t('creator')}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', ...NO_DRAG }}>
          <select
            value={locale}
            onChange={handleLangChange}
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: 'var(--text-secondary)',
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '4px',
              marginRight: '8px',
              cursor: 'pointer',
              height: '24px',
              outline: 'none',
              fontWeight: 500,
              fontFamily: 'inherit',
              ...NO_DRAG
            }}
          >
            <option value="ko" style={{ background: '#0a0b10', color: '#fff' }}>KR</option>
            <option value="en" style={{ background: '#0a0b10', color: '#fff' }}>EN</option>
            <option value="ja" style={{ background: '#0a0b10', color: '#fff' }}>JP</option>
          </select>

          <button
            className="control-btn"
            onClick={() => setIsOpenSettingsModal(true)}
            title={t('settingsTitle')}
            type="button"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '12.5px',
              padding: '0 12px',
              height: '38px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'color 0.2s',
              fontWeight: 500,
              whiteSpace: 'nowrap'
            }}
          >
            {t('settings')}
          </button>

          <div className="titlebar-controls" style={{ display: 'flex' }}>
            <button className="control-btn btn-minimize" onClick={() => sendWindowCommand('minimize')} title={t('minimize')} type="button">_</button>
            <button className="control-btn btn-maximize" onClick={() => sendWindowCommand('maximize')} title={t('maximize')} type="button">[]</button>
            <button className="control-btn btn-close" onClick={() => sendWindowCommand('close')} title={t('close')} type="button">x</button>
          </div>
        </div>
      </div>

      <div
        className={`dashboard ${isColumnResizing ? 'is-resizing-columns' : ''} ${isRowResizing ? 'is-resizing-rows' : ''}`}
        style={{
          display: 'flex',
          height: 'calc(100vh - 38px)',
          width: '100vw',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <aside
          className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}
          style={{
            width: isSidebarCollapsed ? 0 : `${sidebarWidth}px`,
            display: isSidebarCollapsed ? 'none' : 'flex',
            flexDirection: 'column',
            flexShrink: 0
          }}
        >
          <div
            className="sidebar-header"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid rgba(168, 85, 247, 0.1)',
              padding: '12px 16px'
            }}
          >
            <h3 className="sidebar-title" style={{ color: 'var(--accent-violet)' }}>{t('chatSession')}</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={handleNewSession}
                style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid var(--border-cyan)', color: 'var(--accent-cyan)', fontSize: 10, padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
                title={t('newChat')}
                type="button"
              >
                {t('newChat')}
              </button>
              <button
                onClick={() => handleSaveSession(messages)}
                style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid var(--border-violet)', color: 'var(--accent-violet)', fontSize: 10, padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
                title={t('saveChat')}
                type="button"
              >
                {t('saveChat')}
              </button>
            </div>
          </div>

          <div className="chat-sessions-list" style={{ maxHeight: '220px', overflowY: 'auto', padding: '6px 4px', borderBottom: '1px solid rgba(56, 189, 248, 0.1)' }}>
            {savedSessions?.length > 0 ? (
              savedSessions.map(session => {
                const isSelected = currentSessionId === session.id;
                return (
                  <button
                    key={session.id}
                    className={`tree-node ${isSelected ? 'active' : ''}`}
                    style={{
                      padding: '6px 8px',
                      margin: '2px 4px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      width: 'calc(100% - 8px)',
                      textAlign: 'left'
                    }}
                    onClick={() => handleSelectSession(session)}
                    type="button"
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                      {session.title || t('chatSession')}
                    </span>
                    <span
                      onClick={(event) => handleDeleteSession(event, session.id)}
                      role="button"
                      tabIndex={0}
                      title={t('deleteSession')}
                      style={{ color: '#f87171', marginLeft: 8, fontSize: 11 }}
                    >
                      x
                    </span>
                  </button>
                );
              })
            ) : (
              <div style={{ padding: 10, fontSize: 12, color: '#64748b' }}>{t('noSavedSessions')}</div>
            )}
          </div>

          <div
            className="sidebar-header"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 16px 8px'
            }}
          >
            <h3 className="sidebar-title" style={{ color: 'var(--accent-cyan)' }}>{t('workspace')}</h3>
            <button
              onClick={handleChangeWorkspace}
              style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid var(--border-cyan)', color: 'var(--accent-cyan)', fontSize: 10, padding: '3px 6px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
              type="button"
            >
              {t('change')}
            </button>
          </div>
          <div style={{ padding: '0 16px 8px', color: 'var(--text-secondary)', fontSize: 11, wordBreak: 'break-all' }}>
            {workspacePath || t('noWorkspaceSelected')}
          </div>
          <FileExplorer
            files={files}
            expandedFolders={expandedFolders}
            selectedFile={selectedFile}
            toggleFolder={toggleFolder}
            selectFile={selectFile}
            rootNextOffset={rootNextOffset}
            rootLoading={rootLoading}
            error={fileTreeError}
            loadMore={loadMoreFiles}
            t={t}
          />
        </aside>

        {!isSidebarCollapsed && (
          <div
            className={`resize-handle resize-handle-sidebar ${isResizingSidebar ? 'is-active' : ''}`}
            onPointerDown={(event) => startResize(event, setIsResizingSidebar)}
            onDoubleClick={() => setSidebarWidth(280)}
            title="Resize sidebar"
            role="separator"
            aria-orientation="vertical"
          />
        )}

        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ProductModeRail
            mode={productMode}
            setMode={setProductMode}
            setActiveBrainTab={setActiveBrainTab}
            setInput={setInput}
            t={t}
          />

          <div className="workspace-panels" style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
            <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <ChatPanel
                activeBrainTab={activeBrainTab}
                setActiveBrainTab={setActiveBrainTab}
                locale={locale}
                t={t}
                isThinking={isThinking}
                statusMessage={statusMessage}
                elapsedSeconds={elapsedSeconds}
                lastSignalAgeSeconds={lastSignalAgeSeconds}
                statusHistory={statusHistory}
                recoveryInfo={recoveryInfo}
                handleResumeWithOutputLimit={handleResumeWithOutputLimit}
                handleStopGeneration={handleStopGeneration}
                messages={messages}
                activeTool={activeTool}
                attachments={attachments}
                setAttachments={setAttachments}
                showAttachmentMenu={showAttachmentMenu}
                setShowAttachmentMenu={setShowAttachmentMenu}
                handleFileAttachment={handleFileAttachment}
                removeAttachment={removeAttachment}
                attachmentMenuRef={attachmentMenuRef}
                input={input}
                setInput={setInput}
                handleSendMessage={handleSendMessage}
                tasks={tasks}
                toggleTaskStatus={toggleTaskStatus}
                newTaskInput={newTaskInput}
                setNewTaskInput={setNewTaskInput}
                handleAddTask={handleAddTask}
                collabTopic={collabTopic}
                setCollabTopic={setCollabTopic}
                collabAgents={collabAgents}
                setCollabAgents={setCollabAgents}
                collabMessages={collabMessages}
                setCollabMessages={setCollabMessages}
                isCollaborating={isCollaborating}
                activeCollabAgent={activeCollabAgent}
                handleStartCollaboration={handleStartCollaboration}
                handleStopCollaboration={handleStopCollaboration}
                chatEndRef={chatEndRef}
                terminalLines={terminalLines}
                agentTimeline={agentTimeline}
                checkpoints={checkpoints}
                latestCheckpoint={latestCheckpoint}
                checkpointStatus={checkpointStatus}
                fetchAgentCheckpoints={fetchAgentCheckpoints}
                handleLoadLatestCheckpoint={handleLoadLatestCheckpoint}
                handleResumeLatestCheckpoint={handleResumeLatestCheckpoint}
                config={config}
                modelCatalog={modelCatalog}
                handleSelectModel={handleSelectModel}
                contextEstimate={contextEstimate}
                handleCompressContext={handleCompressContext}
                isCompressing={isCompressing}
              />
            </section>

            {!isRightPanelCollapsed && (
              <>
                <div
                  className={`resize-handle resize-handle-right ${isResizingRightPanel ? 'is-active' : ''}`}
                  onPointerDown={(event) => startResize(event, setIsResizingRightPanel)}
                  onDoubleClick={() => setRightPanelWidth(440)}
                  title="Resize right panel"
                  role="separator"
                  aria-orientation="vertical"
                />
                <aside className="right-work-panel" style={{ width: `${rightPanelWidth}px`, minWidth: 320, display: 'flex', flexDirection: 'column', borderLeft: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div className="tab-bar" style={{ display: 'flex', gap: 6, padding: '8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {RIGHT_TABS.map(tab => (
                      <button
                        key={tab.id}
                        className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => setActiveTab(tab.id)}
                        type="button"
                      >
                        {t(tab.labelKey)}
                      </button>
                    ))}
                    <button
                      className="tab-button"
                      onClick={() => setIsRightPanelCollapsed(true)}
                      title={t('closeRightPanel')}
                      type="button"
                      style={{ marginLeft: 'auto' }}
                    >
                      x
                    </button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                    {renderRightPanel()}
                  </div>
                </aside>
              </>
            )}

            {isRightPanelCollapsed && (
              <button
                className="right-panel-restore"
                onClick={() => setIsRightPanelCollapsed(false)}
                title={t('openRightPanel')}
                type="button"
                style={{ width: 28, border: 'none', borderLeft: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                &lt;
              </button>
            )}
          </div>

          <div
            className={`resize-handle resize-handle-bottom ${isResizingBottomPanel ? 'is-active' : ''}`}
            onPointerDown={(event) => startResize(event, setIsResizingBottomPanel)}
            onDoubleClick={() => setBottomPanelHeight(250)}
            title="Resize terminal"
            role="separator"
            aria-orientation="horizontal"
          />
          <TerminalPanel
            terminalLines={terminalLines}
            setTerminalLines={setTerminalLines}
            terminalEndRef={terminalEndRef}
            bottomPanelHeight={bottomPanelHeight}
            t={t}
          />
        </main>
      </div>

      <SettingsModal
        isOpen={isOpenSettingsModal}
        onClose={() => setIsOpenSettingsModal(false)}
        activeTab={settingsActiveTab}
        setActiveTab={setSettingsActiveTab}
        config={config}
        setConfig={setConfig}
        localModels={localModels}
        localModelError={localModelError}
        isLocalModelLoading={isLocalModelLoading}
        fetchLocalModels={fetchLocalModels}
        runtimeStatus={runtimeStatus}
        runtimeDiscovery={runtimeDiscovery}
        isRuntimeStarting={isRuntimeStarting}
        isRuntimeStopping={isRuntimeStopping}
        handleStartLlamaRuntime={handleStartLlamaRuntime}
        handleStopLlamaRuntime={handleStopLlamaRuntime}
        handleSelectLlamaServerFile={handleSelectLlamaServerFile}
        handleSelectGgufFile={handleSelectGgufFile}
        handleSaveSettings={handleSaveSettings}
        handleAddMemory={handleAddMemory}
        handleDeleteMemory={handleDeleteMemory}
        newMemoryInput={newMemoryInput}
        setNewMemoryInput={setNewMemoryInput}
        settingsStatus={settingsStatus}
        webTestStatus={webTestStatus}
        handleWebTestConnection={handleWebTestConnection}
        locale={locale}
        t={t}
        detectInstalledIdes={detectInstalledIdes}
        detectedIdes={detectedIdes}
        isDetectingIdes={isDetectingIdes}
        selectedLaunchIde={selectedLaunchIde}
        setSelectedLaunchIde={setSelectedLaunchIde}
        isLaunchingIde={isLaunchingIde}
        integrateAndLaunchIde={integrateAndLaunchIde}
        preflightResult={preflightResult}
        isPreflightLoading={isPreflightLoading}
        handleRunPreflight={handleRunPreflight}
        modelCatalog={modelCatalog}
        fetchModelCatalog={fetchModelCatalog}
        handleTestOpengo={handleTestOpengo}
        opengoTest={opengoTest}
        goTest={goTest}
        resetGoTest={() => setGoTest(null)}
        isGoTesting={isGoTesting}
        isGoDiscovering={isGoDiscovering}
        goDiscoveryError={goDiscoveryError}
        handleTestGo={handleTestGo}
        handleDiscoverGo={handleDiscoverGo}
        handleUseGo={handleUseGo}
        handleClearGoKey={handleClearGoKey}
        isOpengoTesting={isOpengoTesting}
        activeModelServer={activeModelServer}
      />

      <SecurityGate
        pendingSecurityAction={pendingSecurityAction}
        handleRespondSecurity={handleRespondSecurity}
        t={t}
      />
    </>
  );
}
