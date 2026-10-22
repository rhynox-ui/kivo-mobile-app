import React, {useCallback} from 'react';
import type {FeedPoll} from '@kivo/shared/polls/types';
import {api} from '../state/session';
import {PollCard, type PollCardData} from './PollCard';

type Props = {postId: string; onError?: (message: string) => void};
const normalize = (poll: FeedPoll): PollCardData => ({
  question: poll.question,
  description: poll.description,
  options: poll.options,
  settings: poll.settings,
  endsAt: poll.endsAt,
  closed: poll.closed,
  totalVoters: poll.totalVoters,
  viewerOptionIds: poll.viewerOptionIds ?? [],
});

export function FeedPollCard({postId, onError}: Props) {
  const load = useCallback(async () => normalize(await api.feedPoll(postId)), [postId]);
  const vote = useCallback(async (optionIds: string[]) => normalize(await api.voteFeedPoll(postId, optionIds)), [postId]);
  const addOption = useCallback(async (label: string) => normalize(await api.addFeedPollOption(postId, label)), [postId]);
  return <PollCard variant="feed" load={load} vote={vote} addOption={addOption} onError={onError}/>;
}
