import { Component } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/shared/ui/button';
/**
 * Default localized fallback UI for {@link ErrorBoundary}.
 * @param props - Fallback props.
 * @returns Fallback panel.
 */
function DefaultErrorFallback({ onReset }) {
    const { t } = useTranslation();
    return (<div role="alert" className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h2 className="text-lg font-semibold text-foreground">{t('errors.boundaryTitle')}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{t('errors.boundaryDescription')}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" onClick={onReset}>
          {t('errors.tryAgain')}
        </Button>
        <Button type="button" variant="outline" asChild>
          <Link to="/">{t('errors.goHome')}</Link>
        </Button>
      </div>
    </div>);
}
/**
 * Catch render errors in the subtree and show a recoverable fallback UI.
 */
export default class ErrorBoundary extends Component {
    state = { hasError: false };
    /**
     * Derive error state from a thrown render error.
     * @returns State patch that enables the fallback UI.
     */
    static getDerivedStateFromError() {
        return { hasError: true };
    }
    /**
     * Log the caught error for diagnostics.
     * @param error - Thrown error.
     * @param info - React error info with component stack.
     */
    componentDidCatch(error, info) {
        console.error('ErrorBoundary caught an error', error, info);
    }
    /**
     * Clear the error so the child tree can remount.
     */
    reset = () => {
        this.setState({ hasError: false });
    };
    /**
     * Render children or the fallback UI when an error was caught.
     * @returns Boundary contents.
     */
    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback(this.reset);
            }
            return <DefaultErrorFallback onReset={this.reset}/>;
        }
        return this.props.children;
    }
}
