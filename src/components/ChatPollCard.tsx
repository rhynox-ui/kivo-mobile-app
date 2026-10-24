import React, {useCallback} from 'react';
import type {ChatPollResults} from '@kivo/shared/polls/types';
import {api} from '../state/session';
import {PollCard, type PollCardData} from './PollCard';

const normalize = (result: ChatPollResults): PollCardData => ({
  question: result.poll.question,
  description: result.poll.description,
  options: result.options,
  settings: result.poll.settings,
  endsAt: result.poll.endsAt,
  closed: result.closed,
  totalVoters: result.totalVoters,
  viewerOptionIds: result.viewerOptionIds ?? [],
});

export function ChatPollCard({messageId, onError}: {messageId: string; onError?: (message: string) => void}) {
  const load = useCallback(async () => normalize(await api.chatPoll(messageId)), [messageId]);
  const vote = useCallback(async (optionIds: string[]) => normalize(await api.voteChatPoll(messageId, optionIds)), [messageId]);
  const addOption = useCallback(async (label: string) => normalize(await api.addChatPollOption(messageId, label)), [messageId]);
  return <PollCard variant="chat" load={load} vote={vote} addOption={addOption} onError={onError}/>;
}
