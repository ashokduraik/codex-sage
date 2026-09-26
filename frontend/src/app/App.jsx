import { BrowserRouter } from 'react-router-dom';
import { Providers } from '@/app/providers';
import { AppRoutes } from '@/app/routes';
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
