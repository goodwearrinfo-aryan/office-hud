import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class TerminalErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('TerminalErrorBoundary caught:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="panel p-4 text-center">
          <div className="text-hud-red font-mono text-sm mb-2">
            Terminal renderer crashed
          </div>
          <pre className="text-xs text-hud-dim overflow-auto max-h-32">
            {this.state.error?.message}
          </pre>
          <button
            type="button"
            className="btn btn-primary mt-2"
            onClick={this.handleReset}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
