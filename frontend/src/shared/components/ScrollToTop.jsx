import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
/**
 * Decode a location hash fragment into an element id.
 * @param hash - Hash string including the leading `#`.
 * @returns Decoded element id (without `#`).
 */
function getHashId(hash) {
    const rawId = hash.slice(1);
    try {
        return decodeURIComponent(rawId);
    }
    catch {
        return rawId;
    }
}
/**
 * Scroll to top on push/replace navigations, or to a hash target when present.
 * Skips browser back/forward (`POP`) so history scroll restoration can apply.
 * @returns `null` (side-effect only).
 */
export default function ScrollToTop() {
    const { pathname, hash } = useLocation();
    const navigationType = useNavigationType();
    useEffect(() => {
        if (navigationType === 'POP') {
            return;
        }
        if (hash) {
            const id = getHashId(hash);
            const timer = window.setTimeout(() => {
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
            }, 50);
            return () => window.clearTimeout(timer);
        }
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }, [pathname, hash, navigationType]);
    return null;
}
