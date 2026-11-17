import React, { useState } from 'react';

interface InfoTipProps {
  text: string;
  label?: string;
}

export const InfoTip: React.FC<InfoTipProps> = ({ text, label = 'Más información' }) => {
  const [pinned, setPinned] = useState(false);

  return (
    <span className={`info-tip-wrap${pinned ? ' open' : ''}`}>
      <button
        type="button"
        className="info-tip-btn"
        aria-label={label}
        aria-expanded={pinned}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPinned((prev) => !prev);
        }}
        onBlur={() => setPinned(false)}
      >
        ⓘ
      </button>
      <span role="tooltip" className="info-tip-bubble">
        {text}
      </span>
    </span>
  );
};
