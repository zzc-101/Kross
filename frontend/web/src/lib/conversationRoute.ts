import { useCallback, useEffect, useState } from 'react';

const KEY = 'app.conversation-id';

export function useConversationRoute() {
  const [conversationId, setConversationIdState] = useState<string | undefined>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('c');
    return fromUrl || localStorage.getItem(KEY) || undefined;
  });

  const setConversationId = useCallback((id: string | undefined) => {
    setConversationIdState(id);
    const url = new URL(window.location.href);
    if (id) {
      url.searchParams.set('c', id);
      localStorage.setItem(KEY, id);
    } else {
      url.searchParams.delete('c');
      localStorage.removeItem(KEY);
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, []);

  useEffect(() => {
    const onPop = () => {
      setConversationIdState(new URLSearchParams(window.location.search).get('c') || undefined);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return { conversationId, setConversationId };
}
