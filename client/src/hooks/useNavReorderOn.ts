// この人に「並べ替え」が効いているか（2026-10-17）。中身は hooks/useNavRolloutOn（3つの切り替えで共通）
import { useNavRolloutOn } from './useNavRolloutOn';

export function useNavReorderOn(): boolean {
  return useNavRolloutOn('reorder');
}
