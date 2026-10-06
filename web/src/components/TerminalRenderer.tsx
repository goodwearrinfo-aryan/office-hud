import { useEffect, useRef, useState, useMemo } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import 'xterm/css/xterm.css';

interface TerminalRendererProps {
  cols?: number;
  rows?: number;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  scrollback?: number;
}

export default function TerminalRenderer({
  cols = 80,
  rows = 24,
  onData,
  onResize,
  scrollback = 10000,
}: TerminalRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchActive, setSearchActive] = useState(false);

  const terminal = useMemo(() => {
    const term = new Terminal({
      cols,
      rows,
      scrollback,
      cursorBlink: true,
      convertEol: true,
      allowTransparency: true,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());

    term.onData((data) => {
      onData?.(data);
    });

    term.onResize(({ cols, rows }) => {
      onResize?.(cols, rows);
    });

    return { terminal: term, fitAddon, searchAddon };
  }, [cols, rows, onData, onResize, scrollback]);

  useEffect(() => {
    if (!containerRef.current) return;
    terminal.terminal.open(containerRef.current);
    terminal.fitAddon.fit();
    return () => {
      terminal.terminal.dispose();
    };
  }, [terminal]);

  useEffect(() => {
    if (!searchActive) return;
    if (searchTerm) {
      terminal.searchAddon.findNext(searchTerm);
    }
    return () => {
      terminal.searchAddon.clearDecorations();
    };
  }, [searchTerm, searchActive, terminal]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      setSearchActive(true);
    }
    if (e.key === 'Escape') {
      setSearchActive(false);
      setSearchTerm('');
      terminal.searchAddon.clearDecorations();
    }
  };

  return (
    <div
      ref={containerRef}
      className="terminal-renderer font-mono text-sm"
      onKeyDown={handleKeyDown}
      style={{ width: '100%', height: '100%', minHeight: '400px' }}
      tabIndex={0}
    />
  );
}
