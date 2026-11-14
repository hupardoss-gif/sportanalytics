import React, { useState } from 'react';
import type { AvailabilityStatus } from '../types/sports.ts';

interface PlayerAvatarProps {
  name: string;
  number: number;
  photoUrl?: string;
  availability?: AvailabilityStatus;
  size?: 'sm' | 'md' | 'lg';
  accent?: 'blue' | 'slate';
}

export const PlayerAvatar: React.FC<PlayerAvatarProps> = ({
  name,
  number,
  photoUrl,
  availability = 'starter',
  size = 'md',
  accent = 'blue',
}) => {
  const [imgFailed, setImgFailed] = useState(false);

  const dims =
    size === 'sm'
      ? 'w-9 h-9 text-xs'
      : size === 'lg'
      ? 'w-16 h-16 text-lg'
      : 'w-11 h-11 text-sm';

  const ringClass =
    availability === 'out' || availability === 'suspended'
      ? 'ring-2 ring-rose-500/80'
      : availability === 'doubtful'
        ? 'ring-2 ring-amber-400/80'
        : availability === 'probable'
          ? 'ring-2 ring-amber-300/60'
          : availability === 'confirmed_starter'
            ? 'ring-2 ring-emerald-400/80'
            : availability === 'possible_starter'
              ? 'ring-2 ring-blue-400/75'
              : availability === 'available' || availability === 'bench'
                ? 'ring-1 ring-slate-400/50'
                : accent === 'blue'
                  ? 'ring-1 ring-blue-400/50'
                  : 'ring-1 ring-slate-400/40';

  const bgClass =
    availability === 'out' || availability === 'suspended'
      ? 'bg-rose-950/80 text-rose-200'
      : accent === 'blue'
      ? 'bg-gradient-to-br from-blue-600/90 to-slate-900 text-white'
      : 'bg-gradient-to-br from-slate-700 to-slate-900 text-slate-100';

  if (photoUrl && !imgFailed) {
    return (
      <div className={`${dims} ${ringClass} rounded-full overflow-hidden shrink-0 bg-slate-900`}>
        <img
          src={photoUrl}
          alt={name}
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      className={`${dims} ${ringClass} ${bgClass} rounded-full shrink-0 flex items-center justify-center font-mono font-bold tabular-nums select-none`}
      aria-label={`${name} dorsal ${number}`}
    >
      {number}
    </div>
  );
};
