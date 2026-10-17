/**
 * Reads Phase 40 `searchAttachment` navigation state once and clears it from history.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * @typedef {{ id?: string, knowledgeVersionId?: string | null, title?: string }} SearchAttachment
 */

/**
 * Consumes `location.state.searchAttachment` for the composer chip.
 * @returns {{ attachment: SearchAttachment | null, clearAttachment: () => void }}
 */
export function useAskAboutContext() {
  const location = useLocation();
  const navigate = useNavigate();
  const [attachment, setAttachment] = useState(/** @type {SearchAttachment | null} */ (null));

  useEffect(() => {
    const incoming = location.state?.searchAttachment;
    if (!incoming || typeof incoming !== 'object') {
      return;
    }
    const next = {
      id: typeof incoming.id === 'string' ? incoming.id : undefined,
      knowledgeVersionId: typeof incoming.knowledgeVersionId === 'string' ? incoming.knowledgeVersionId : null,
      title: typeof incoming.title === 'string' ? incoming.title : undefined,
    };
    setAttachment(next);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: {} });
  }, [location.pathname, location.search, location.state, navigate]);

  /**
   * Clears the ask-about chip after send or user dismiss.
   */
  const clearAttachment = () => {
    setAttachment(null);
  };

  return { attachment, clearAttachment };
}
