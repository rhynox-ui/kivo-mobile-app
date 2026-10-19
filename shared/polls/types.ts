export type PollSettings = {
  showVoters: boolean;
  allowMultiple: boolean;
  allowAddingOptions: boolean;
  allowRevoting: boolean;
  shuffleOptions: boolean;
};
export type PollSettingsWithDuration = PollSettings & { durationHours: number | null };
export type PollOption = { id: string; label: string };
export type PollOptionResult = PollOption & { voteCount: number; voterNames?: string[] };
export type PollPayload = { question: string; description: string; options: PollOption[]; settings: PollSettings; endsAt: number | null };
export type PollResults = { options: PollOptionResult[]; totalVoters: number; viewerOptionIds: string[]; closed: boolean };
export type FeedPoll = PollPayload & PollResults & { id: string; postId: string };
export type ChatPollPayload = { question: string; description: string; options: string[]; settings: PollSettings; endsAt: number | null };
export type ChatPollMessage = PollPayload;
export type ChatPollResults = PollResults & { messageId: string; conversationId: string; poll: ChatPollMessage };
export const DEFAULT_POLL_SETTINGS: Readonly<PollSettings> = Object.freeze({
  showVoters: false, allowMultiple: false, allowAddingOptions: false, allowRevoting: true, shuffleOptions: false,
});
export const POLL_DURATION_OPTIONS = [
  { hours: null, label: 'No time limit' }, { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' }, { hours: 12, label: '12 hours' },
  { hours: 24, label: '1 day' }, { hours: 72, label: '3 days' }, { hours: 168, label: '7 days' },
] as const;
export const normalizePollQuestion = (value: string) => {
  const question = value.trim();
  if (!question) throw new Error('Enter a poll question.');
  if (question.length > 200) throw new Error('Poll questions can have up to 200 characters.');
  return question;
};
export const normalizePollDescription = (value: string) => {
  const description = value.trim();
  if (description.length > 500) throw new Error('Poll descriptions can have up to 500 characters.');
  return description;
};
export const normalizePollOptions = (values: string[]) => {
  const options = values.map(value => value.trim()).filter(Boolean);
  if (options.length < 2) throw new Error('Add at least two options.');
  if (options.length > 12) throw new Error('Polls can have up to 12 options.');
  if (options.some(value => value.length > 100)) throw new Error('Options can have up to 100 characters.');
  if (new Set(options.map(value => value.toLocaleLowerCase())).size !== options.length) throw new Error('Poll options must be unique.');
  return options;
};
