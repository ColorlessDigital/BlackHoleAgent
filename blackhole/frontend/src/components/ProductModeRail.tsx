import React from 'react';
import type { TranslateFn } from '../types.ts';

const MODES = [
  { id: 'chat', titleKey: 'modeChat', subtitleKey: 'modeChatSubtitle', promptKey: 'modeChatPrompt', tab: 'chat' },
  { id: 'edit', titleKey: 'modeEdit', subtitleKey: 'modeEditSubtitle', promptKey: 'modeEditPrompt', tab: 'chat' },
  { id: 'agent', titleKey: 'modeAgent', subtitleKey: 'modeAgentSubtitle', promptKey: 'modeAgentPrompt', tab: 'timeline' },
  { id: 'autocomplete', titleKey: 'modeAutocomplete', subtitleKey: 'modeAutocompleteSubtitle', promptKey: 'modeAutocompletePrompt', tab: 'chat' }
];

const ProductModeRail = React.memo(function ProductModeRail({ mode, setMode, setActiveBrainTab, setInput, t }: {
  mode: string;
  setMode: (mode: string) => void;
  setActiveBrainTab: (tab: string) => void;
  setInput: (input: string) => void;
  t: TranslateFn;
}) {
  const selected = MODES.find(item => item.id === mode) || MODES[2];

  const applyPrompt = () => {
    setActiveBrainTab(selected.tab);
    setInput(t(selected.promptKey));
  };

  return (
    <div className="product-mode-rail">
      <div className="product-mode-buttons">
        {MODES.map(item => (
          <button
            key={item.id}
            className={`product-mode-button ${mode === item.id ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setMode(item.id);
              setActiveBrainTab(item.tab);
            }}
          >
            <span>{t(item.titleKey)}</span>
            <small>{t(item.subtitleKey)}</small>
          </button>
        ))}
      </div>
      <button className="product-mode-apply" type="button" onClick={applyPrompt}>
        {t('useModePrompt', { mode: t(selected.titleKey) })}
      </button>
    </div>
  );
});

export default ProductModeRail;
