import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import type {PollOptionResult, PollSettings} from '@kivo/shared/polls/types';
import {kivoTheme} from '../theme/kivoTheme';

const c = kivoTheme.colors;

export type PollCardData = {
  question: string;
  description: string;
  options: PollOptionResult[];
  settings: PollSettings;
  endsAt: number | null;
  closed: boolean;
  totalVoters: number;
  viewerOptionIds: string[];
};

type Props = {
  variant: 'feed' | 'chat';
  load: () => Promise<PollCardData>;
  vote: (optionIds: string[]) => Promise<PollCardData>;
  addOption: (label: string) => Promise<PollCardData>;
  onError?: (message: string) => void;
};

export function PollCard({variant, load, vote, addOption, onError}: Props) {
  const [poll, setPoll] = useState<PollCardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [suggestion, setSuggestion] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [shuffleSeed, setShuffleSeed] = useState(0);

  const apply = useCallback((next: PollCardData) => {
    setPoll(next);
    setSelected(next.viewerOptionIds ?? []);
    setShowResults((next.viewerOptionIds ?? []).length > 0);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      apply(await load());
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Could not load poll results.');
    } finally {
      setLoading(false);
    }
  }, [apply, load, onError]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void load().then(result => {
      if (active) {
        setPoll(result);
        setSelected(result.viewerOptionIds ?? []);
        setShowResults((result.viewerOptionIds ?? []).length > 0);
        setShuffleSeed(seed => seed + 1);
      }
    }).catch(error => {
      if (active) onError?.(error instanceof Error ? error.message : 'Could not load poll results.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, onError]);

  const orderedOptions = useMemo(() => {
    if (!poll?.settings.shuffleOptions) return poll?.options ?? [];
    // Stable shuffle per loaded poll; avoid reordering options on each render.
    return [...(poll.options ?? [])].sort((a, b) => {
      const score = (id: string) => {
        let n = shuffleSeed + 17;
        for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) | 0;
        return n;
      };
      return score(a.id) - score(b.id);
    });
  }, [poll, shuffleSeed]);

  const act = async (action: () => Promise<PollCardData>) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await action();
      apply(next);
      setShowResults(true);
      setShuffleSeed(seed => seed + 1);
      setSuggestion('');
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Poll action failed.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !poll) return <View style={s.loading}><ActivityIndicator color={c.accent}/><Text style={s.muted}>Loading poll…</Text></View>;
  if (!poll) return <View style={s.loading}><Text style={s.muted}>Poll unavailable.</Text><Pressable onPress={() => void refresh()}><Text style={s.link}>Retry</Text></Pressable></View>;

  const hasVoted = (poll.viewerOptionIds ?? []).length > 0;
  const canVote = !poll.closed && (!hasVoted || poll.settings.allowRevoting);
  return <View style={[s.card, variant === 'chat' && s.chatCard]}>
    <Text style={s.question}>{poll.question}</Text>
    {!!poll.description && <Text style={s.description}>{poll.description}</Text>}
    {orderedOptions.map(option => {
      const picked = selected.includes(option.id);
      const count = option.voteCount ?? 0;
      const percent = poll.totalVoters ? Math.round(count / Math.max(1, poll.totalVoters) * 100) : 0;
      return <Pressable key={option.id} disabled={!canVote || busy} onPress={() => setSelected(old =>
        picked ? (poll.settings.allowMultiple ? old.filter(id => id !== option.id) : old)
          : poll.settings.allowMultiple ? [...old, option.id] : [option.id])} style={[s.option, picked && s.optionPicked]}>
        <View style={s.optionTop}><Text style={s.optionLabel}>{option.label}</Text>{showResults && <Text style={s.count}>{count} · {percent}%</Text>}</View>
        {showResults && <View style={s.track}><View style={[s.bar, {width: percent + '%'}]}/></View>}
        {picked && <Text style={s.selected}>✓ Selected</Text>}
        {showResults && poll.settings.showVoters && option.voterNames?.length ? <Text style={s.voters}>{option.voterNames.slice(0, 8).join(', ')}</Text> : null}
      </Pressable>;
    })}
    <View style={s.footer}>
      <Text style={s.muted}>{poll.totalVoters} vote{poll.totalVoters === 1 ? '' : 's'}{poll.endsAt ? ' · ' + (poll.closed ? 'Closed' : 'Ends ' + new Date(poll.endsAt).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})) : ' · No time limit'}</Text>
      <Pressable disabled={busy} onPress={() => void refresh()}><Text style={s.link}>Refresh</Text></Pressable>
    </View>
    {canVote ? <Pressable disabled={busy || !selected.length} onPress={() => void act(() => vote(selected))} style={[s.voteButton, (busy || !selected.length) && s.disabled]}><Text style={s.voteText}>{busy ? 'Saving…' : hasVoted ? 'Change vote' : 'Vote'}</Text></Pressable> : <Text style={s.closed}>{poll.closed ? 'Poll closed' : 'Voting closed'}</Text>}
    {!poll.closed && poll.settings.allowAddingOptions && <View style={s.suggest}><TextInput value={suggestion} onChangeText={setSuggestion} maxLength={100} placeholder="Suggest an option" placeholderTextColor={c.textMuted} style={s.suggestInput}/><Pressable disabled={busy || !suggestion.trim()} onPress={() => void act(() => addOption(suggestion.trim()))}><Text style={s.link}>Add</Text></Pressable></View>}
    {!showResults && <Pressable onPress={() => setShowResults(true)}><Text style={s.link}>View results</Text></Pressable>}
  </View>;
}

const s = StyleSheet.create({
  card:{borderWidth:1,borderColor:c.border,borderRadius:16,padding:12,gap:10,backgroundColor:c.background,minWidth:0},
  chatCard:{borderRadius:14,padding:10},
  loading:{padding:14,alignItems:'center',gap:8},
  question:{color:c.text,fontSize:17,fontWeight:'900'},
  description:{color:c.textMuted,fontSize:13,lineHeight:18},
  option:{borderWidth:1,borderColor:c.border,borderRadius:10,padding:10,gap:5},
  optionPicked:{borderColor:c.accent},
  optionTop:{flexDirection:'row',justifyContent:'space-between',gap:8},
  optionLabel:{color:c.text,fontWeight:'700',flex:1},
  count:{color:c.textMuted,fontSize:12},
  track:{height:4,backgroundColor:c.surfaceRaised,borderRadius:3,overflow:'hidden'},
  bar:{height:4,backgroundColor:c.accent},
  selected:{color:c.accent,fontSize:11,fontWeight:'800'},
  voters:{color:c.textMuted,fontSize:11},
  footer:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8},
  muted:{color:c.textMuted,fontSize:12,flexShrink:1},
  link:{color:c.accent,fontWeight:'800'},
  voteButton:{alignItems:'center',backgroundColor:c.accent,padding:11,borderRadius:12},
  voteText:{color:c.backgroundDeep,fontWeight:'900'},
  disabled:{opacity:0.45},
  closed:{color:c.textMuted,fontWeight:'700',textAlign:'center'},
  suggest:{flexDirection:'row',alignItems:'center',gap:10},
  suggestInput:{flex:1,color:c.text,borderWidth:1,borderColor:c.border,borderRadius:10,paddingHorizontal:10,paddingVertical:8},
});
