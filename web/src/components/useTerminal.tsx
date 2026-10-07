import { useEffect, useRef, useState, useCallback } from 'react';

interface UseTerminalOptions {
  terminalId: string | null;
  onData?: (data: string) => void;
  onConnectionChange?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}

export function useTerminal({
  terminalId,
  onData,
  onConnectionChange,
  onError,
}: UseTerminalOptions) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const maxReconnectAttempts = 10;
  const baseReconnectDelay = 1000;

  const connect = useCallback(() => {
    if (!terminalId) return;
    if (eventSourceRef.current) return;

    setConnecting(true);
    const es = new EventSource(`/api/terminals/${encodeURIComponent(terminalId)}/follow`);
    eventSourceRef.current = es;

    es.addEventListener('hello', () => {
      reconnectAttempts.current = 0;
      setConnected(true);
      setConnecting(false);
      onConnectionChange?.(true);
    });

    es.addEventListener('log', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.text) onData?.(data.text);
      } catch {
        // Ignore malformed
      }
    });

    es.addEventListener('output', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.text) onData?.(data.text);
      } catch {
        // Ignore malformed
      }
    });

    es.onmessage = (event) => {
      if (event.data.startsWith('data: ')) {
        try {
          const data = JSON.parse(event.data.slice(6));
          if (data.text) onData?.(data.text);
        } catch {
          // Ignore
        }
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      setConnected(false);
      onConnectionChange?.(false);

      if (reconnectAttempts.current < maxReconnectAttempts) {
        const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectAttempts.current++;
          connect();
        }, delay);
      } else {
        onError?.(new Error('Max reconnection attempts reached'));
      }
    };
  }, [terminalId, onData, onConnectionChange, onError]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
    setConnecting(false);
  }, []);

  const sendInput = useCallback(async (text: string) => {
    if (!terminalId) return false;
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }, [terminalId]);

  const resize = useCallback(async (cols: number, rows: number) => {
    if (!terminalId) return false;
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }, [terminalId]);

  useEffect(() => {
    if (terminalId) {
      connect();
    } else {
      disconnect();
    }
    return () => disconnect();
  }, [terminalId, connect, disconnect]);

  return {
    connected,
    connecting,
    sendInput,
    resize,
    reconnect: connect,
    disconnect,
  };
}
