import { useEffect, useCallback } from 'react';

interface Shortcut {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  action: () => void;
  description?: string;
}

export function useKeyboard(shortcuts: Shortcut[], enabled = true) {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!enabled) return;
    
    // Don't trigger shortcuts when typing in inputs
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    for (const shortcut of shortcuts) {
      const keyMatches = event.key.toLowerCase() === shortcut.key.toLowerCase();
      const ctrlMatches = !!shortcut.ctrlKey === event.ctrlKey;
      const shiftMatches = !!shortcut.shiftKey === event.shiftKey;
      const altMatches = !!shortcut.altKey === event.altKey;
      const metaMatches = !!shortcut.metaKey === event.metaKey;

      if (keyMatches && ctrlMatches && shiftMatches && altMatches && metaMatches) {
        event.preventDefault();
        shortcut.action();
        break;
      }
    }
  }, [shortcuts, enabled]);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown, enabled]);
}

// Floor navigation shortcuts
export function useFloorShortcuts(onNavigate: (floor: string) => void, enabled = true) {
  const shortcuts = [
    { key: '1', action: () => onNavigate('f1'), description: 'F1 Sessions' },
    { key: '2', action: () => onNavigate('f2'), description: 'F2 Ledger' },
    { key: '3', action: () => onNavigate('f3'), description: 'F3 Agents' },
    { key: '4', action: () => onNavigate('f4'), description: 'F4 Projects' },
    { key: '5', action: () => onNavigate('f5'), description: 'F5 HQ' },
    { key: '6', action: () => onNavigate('f6'), description: 'F6 Trading Lab' },
    { key: '7', action: () => onNavigate('f7'), description: 'F7 Strategy Lab' },
    { key: '8', action: () => onNavigate('f8'), description: 'F8 Live Trading' },
    { key: '9', action: () => onNavigate('f9'), description: 'F9 24x7 Ops' },
    { key: '0', action: () => onNavigate('f10'), description: 'F10 Knowledge' },
    { key: '-', action: () => onNavigate('f11'), description: 'F11 Risk Metrics' },
    { key: '=', action: () => onNavigate('f12'), description: 'F12 Knowledge Graph' },
    { key: 'Backspace', action: () => onNavigate('f16'), description: 'F16 Overview' },
  ];
  useKeyboard(shortcuts, enabled);
}

// Global shortcuts
export function useGlobalShortcuts(
  onSearch: () => void,
  onCommandPalette: () => void,
  enabled = true
) {
  const shortcuts = [
    { key: '/', action: onSearch, description: 'Search' },
    { key: 'p', ctrlKey: true, action: onCommandPalette, description: 'Command Palette' },
  ];
  useKeyboard(shortcuts, enabled);
}