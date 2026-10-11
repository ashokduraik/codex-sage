import { AppRoutes } from '@/app/routes';
import { Providers } from '@/app/providers';
import { BrowserRouter } from 'react-router-dom';
import { ScrollToTop } from '@/shared/components';

/**
 * Root application: router, providers, scroll restoration, and routes.
 *
 * @returns Application tree.
 */
export function App() {
  return (
    <BrowserRouter>
      <Providers>
        <ScrollToTop />
        <AppRoutes />
      </Providers>
    </BrowserRouter>
  );
}
export default App;
