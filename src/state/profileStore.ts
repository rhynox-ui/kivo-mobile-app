import { useEffect, useState } from 'react';
import { getProfile, subscribeToProfile, type KivoProfile } from '@kivo/shared/profile/store';

// Profile model, validation and persistence are shared with Kivo web.
export * from '@kivo/shared/profile/store';

export function useProfile(): KivoProfile {
  const [value, setValue] = useState(getProfile);
  useEffect(() => subscribeToProfile(setValue), []);
  return value;
}
