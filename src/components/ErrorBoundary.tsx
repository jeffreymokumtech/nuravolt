'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackDescription?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Component error caught by ErrorBoundary:', error, errorInfo);
    this.setState({
      error,
      errorInfo
    });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <Card className="border-red-200 bg-blue-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-5 w-5" />
              {this.props.fallbackTitle || 'Component Error'}
            </CardTitle>
            <CardDescription className="text-blue-700">
              {this.props.fallbackDescription || 'Something went wrong with this component.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {this.state.error && (
              <div className="mb-4 p-3 bg-blue-100 rounded-lg">
                <p className="text-sm font-medium text-red-800">Error Details:</p>
                <p className="text-xs text-red-700 font-mono mt-1">
                  {this.state.error.message}
                </p>
              </div>
            )}
            
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={this.handleRetry}
                className="flex items-center gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                Try Again
              </Button>
              
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.location.reload()}
                className="text-xs"
              >
                Reload Page
              </Button>
            </div>
            
            {process.env.NODE_ENV === 'development' && this.state.errorInfo && (
              <details className="mt-4">
                <summary className="text-sm font-medium text-red-800 cursor-pointer">
                  Stack Trace (Development Only)
                </summary>
                <pre className="text-xs text-red-700 mt-2 p-2 bg-blue-100 rounded overflow-auto">
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}

// Functional component version for specific use cases
export function SimpleErrorFallback({ 
  error, 
  resetError 
}: { 
  error: Error; 
  resetError: () => void 
}) {
  return (
    <div className="p-4 border border-red-200 bg-blue-50 rounded-lg">
      <div className="flex items-center gap-2 text-red-700 mb-2">
        <AlertTriangle className="h-4 w-4" />
        <span className="font-medium">Error Loading Component</span>
      </div>
      <p className="text-sm text-blue-700 mb-3">{error.message}</p>
      <Button size="sm" variant="outline" onClick={resetError}>
        <RefreshCw className="h-4 w-4 mr-2" />
        Retry
      </Button>
    </div>
  );
}