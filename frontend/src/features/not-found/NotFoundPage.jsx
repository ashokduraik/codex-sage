import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

/**
 * 404 page for unknown routes — no Base44 admin/AI builder hints.
 *
 * @returns Not-found message with a link home.
 */
export default function NotFoundPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const pageName = location.pathname.substring(1);
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md">
        <div className="space-y-6 text-center">
          <div className="space-y-2">
            <h1 className="text-7xl font-light text-slate-300">404</h1>
            <div className="mx-auto h-0.5 w-16 bg-slate-200" />
          </div>

          <div className="space-y-3">
            <h2 className="text-2xl font-medium text-slate-800">{t('errors.notFound')}</h2>
            <p className="leading-relaxed text-slate-600">
              {t('errors.notFoundDescription')}
              {pageName ? (
                <>
                  {' '}
                  <span className="font-medium text-slate-700">&ldquo;{pageName}&rdquo;</span>
                </>
              ) : null}
            </p>
          </div>

          <div className="pt-6">
            <Button asChild variant="outline">
              <Link to="/">{t('errors.goHome')}</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
