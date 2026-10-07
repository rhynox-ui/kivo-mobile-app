import { useEffect, useState } from 'react';
import { getChatState, setActiveConversation, subscribeChat, type ChatState } from '@kivo/shared/chat/store';

export function useChatState(): ChatState {
  const [state, setState] = useState<ChatState>(getChatState);
  useEffect(() => subscribeChat(setState), []);
  return state;
}

/** Marks a conversation as open (fast sync + read receipts) while the screen is mounted. */
export function useActiveConversation(id: string) {
  useEffect(() => {
    setActiveConversation(id);
    return () => setActiveConversation(null);
  }, [id]);
}
