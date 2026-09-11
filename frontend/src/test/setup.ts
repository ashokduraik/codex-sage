import { configure } from '@testing-library/react';

/** Allow async UI to settle under parallel jsdom workers. */
configure({ asyncUtilTimeout: 5000 });
