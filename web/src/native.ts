export function markNative(): boolean {
  return false;
}

export function onShellCommand(_callback: (command: string, payload: any) => void): () => void {
  return () => {};
}

export function parseDeepLink(_link: string): { floor?: string; agentId?: string } | null {
  return null;
}
