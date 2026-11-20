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
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          shapeRendering="geometricPrecision"
        >
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 7.1V11.2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="4.75" r="0.9" fill="currentColor" />
        </svg>
      </button>
      <span role="tooltip" className="info-tip-bubble">
        {text}
      </span>
    </span>
  );
};
