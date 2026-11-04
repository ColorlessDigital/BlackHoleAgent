import { useState, useRef, useEffect, useCallback } from 'react';
import type React from 'react';
import { TRANSLATIONS } from '../translations.ts';
import type { AppendTerminal, ChatAttachment, Locale, TranslateFn } from '../types.ts';

export default function useLayoutState(appendTerminal: AppendTerminal | undefined) {
  const [locale, setLocale] = useState<Locale>((localStorage.getItem('bh_lang') as Locale) || 'ko');

  const t: TranslateFn = (key, params = {}) => {
    const template = TRANSLATIONS[locale]?.[key] || TRANSLATIONS.ko?.[key] || key;
    return Object.entries(params).reduce(
      (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
      template
    );
  };

  const [activeTab, setActiveTab] = useState('code');
  const [activeBrainTab, setActiveBrainTab] = useState('chat');

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => window.innerWidth <= 920);
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(() => window.innerWidth <= 1100);

  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(440);
  const [isResizingRightPanel, setIsResizingRightPanel] = useState(false);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(250);
  const [isResizingBottomPanel, setIsResizingBottomPanel] = useState(false);

  const [isOpenSettingsModal, setIsOpenSettingsModal] = useState(false);
  const [settingsActiveTab, setSettingsActiveTab] = useState('gguf');

  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);

  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sidebarQuery = window.matchMedia('(max-width: 920px)');
    const rightPanelQuery = window.matchMedia('(max-width: 1100px)');
    const collapseSidebar = (event: MediaQueryListEvent) => {
      if (event.matches) setIsSidebarCollapsed(true);
    };
    const collapseRightPanel = (event: MediaQueryListEvent) => {
      if (event.matches) setIsRightPanelCollapsed(true);
    };
    sidebarQuery.addEventListener('change', collapseSidebar);
    rightPanelQuery.addEventListener('change', collapseRightPanel);
    return () => {
      sidebarQuery.removeEventListener('change', collapseSidebar);
      rightPanelQuery.removeEventListener('change', collapseRightPanel);
    };
  }, []);

  const clearResizeState = useCallback(() => {
    setIsResizingSidebar(false);
    setIsResizingRightPanel(false);
    setIsResizingBottomPanel(false);
  }, []);

  // Resize event handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent | PointerEvent) => {
      if (!isResizingSidebar) return;
      const newWidth = Math.max(220, Math.min(480, e.clientX));
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => clearResizeState();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearResizeState();
    };

    if (isResizingSidebar) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('pointermove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('pointerup', handleMouseUp);
      window.addEventListener('pointercancel', handleMouseUp);
      window.addEventListener('blur', handleMouseUp);
      document.addEventListener('mouseleave', handleMouseUp);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
      window.removeEventListener('blur', handleMouseUp);
      document.removeEventListener('mouseleave', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [clearResizeState, isResizingSidebar]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent | PointerEvent) => {
      if (!isResizingRightPanel) return;
      const containerWidth = window.innerWidth;
      const currentSidebarWidth = isSidebarCollapsed ? 0 : sidebarWidth;
      const maxRightPanelWidth = containerWidth - currentSidebarWidth - 420;
      const newWidth = Math.max(320, Math.min(maxRightPanelWidth, containerWidth - e.clientX));
      setRightPanelWidth(newWidth);
    };
    const handleMouseUp = () => clearResizeState();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearResizeState();
    };

    if (isResizingRightPanel) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('pointermove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('pointerup', handleMouseUp);
      window.addEventListener('pointercancel', handleMouseUp);
      window.addEventListener('blur', handleMouseUp);
      document.addEventListener('mouseleave', handleMouseUp);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
      window.removeEventListener('blur', handleMouseUp);
      document.removeEventListener('mouseleave', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [clearResizeState, isResizingRightPanel, isSidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent | PointerEvent) => {
      if (!isResizingBottomPanel) return;
      const containerHeight = window.innerHeight;
      const newHeight = Math.max(100, Math.min(containerHeight - 200, containerHeight - e.clientY));
      setBottomPanelHeight(newHeight);
    };
    const handleMouseUp = () => clearResizeState();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearResizeState();
    };

    if (isResizingBottomPanel) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('pointermove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('pointerup', handleMouseUp);
      window.addEventListener('pointercancel', handleMouseUp);
      window.addEventListener('blur', handleMouseUp);
      document.addEventListener('mouseleave', handleMouseUp);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
      window.removeEventListener('blur', handleMouseUp);
      document.removeEventListener('mouseleave', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [clearResizeState, isResizingBottomPanel]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (attachmentMenuRef.current && !attachmentMenuRef.current.contains(e.target as Node)) {
        setShowAttachmentMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleLangChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const nextLang = e.target.value as Locale;
    setLocale(nextLang);
    localStorage.setItem('bh_lang', nextLang);
    if (appendTerminal) {
      const template = TRANSLATIONS[nextLang]?.languageChanged || TRANSLATIONS.ko.languageChanged;
      appendTerminal(template.replaceAll('{lang}', nextLang.toUpperCase()), 'success');
    }
  }

  function handleFileAttachment(e: React.ChangeEvent<HTMLInputElement>, forceType: string | null = null): void {
    const filesList = Array.from(e.target.files || []);
    if (filesList.length === 0) return;

    filesList.forEach(file => {
      const isImg = file.type.startsWith('image/');
      const detectedType = isImg ? 'image' : 'text';
      const actualType = forceType || detectedType;

      const reader = new FileReader();
      reader.onload = (event) => {
        setAttachments(prev => [
          ...prev,
          {
            name: file.name,
            type: actualType,
            data: event.target?.result as string | undefined
          }
        ]);
        if (appendTerminal) {
          appendTerminal(t('attachedFile', { name: file.name, type: actualType.toUpperCase() }), 'success');
        }
      };
      if (actualType === 'image') {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
    e.target.value = '';
  }

  function removeAttachment(index: number): void {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  }

  return {
    locale, setLocale, t, handleLangChange,
    activeTab, setActiveTab, activeBrainTab, setActiveBrainTab,
    isSidebarCollapsed, setIsSidebarCollapsed,
    isRightPanelCollapsed, setIsRightPanelCollapsed,
    sidebarWidth, setSidebarWidth, isResizingSidebar, setIsResizingSidebar,
    rightPanelWidth, setRightPanelWidth, isResizingRightPanel, setIsResizingRightPanel,
    bottomPanelHeight, setBottomPanelHeight, isResizingBottomPanel, setIsResizingBottomPanel,
    isOpenSettingsModal, setIsOpenSettingsModal,
    settingsActiveTab, setSettingsActiveTab,
    attachments, setAttachments,
    showAttachmentMenu, setShowAttachmentMenu,
    attachmentMenuRef, handleFileAttachment, removeAttachment
  };
}
