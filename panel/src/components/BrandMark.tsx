import React from 'react';

interface BrandMarkProps {
  subtitle?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ subtitle }) => {
  return (
    <div className="brand-lockup">
      <svg
        width="42"
        height="42"
        viewBox="0 0 42 42"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <rect
          x="1"
          y="1"
          width="40"
          height="40"
          rx="13"
          fill="#ffffff"
          stroke="var(--line)"
          strokeWidth="1.5"
        />
        {/* Converging Bifrost bridge lines in --accent */}
        <path
          d="M8 31C14.5 29 17.8 21.8 21 10.5C24.2 21.8 27.5 29 34 31"
          stroke="var(--accent)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12.5 33C16.8 30 19 23.5 21 15C23 23.5 25.2 30 29.5 33"
          stroke="var(--accent)"
          strokeOpacity="0.55"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M16.5 34.5C18.8 31.2 20 26.2 21 20C22 26.2 23.2 31.2 25.5 34.5"
          stroke="var(--accent)"
          strokeOpacity="0.3"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="21" cy="10.5" r="3" fill="var(--accent)" />
      </svg>
      <div>
        <span className="brand-wordmark">Bifrost</span>
        {subtitle ? <span className="brand-subtitle">{subtitle}</span> : null}
      </div>
    </div>
  );
};
