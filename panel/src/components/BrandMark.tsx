import React from 'react';

interface BrandMarkProps {
  subtitle?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({ subtitle }) => {
  return (
    <div className="brand-lockup">
      <div className="brand-icon-frame" aria-hidden="true">
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M4 19C8.2 17.6 10.2 12.8 12 5C13.8 12.8 15.8 17.6 20 19"
            stroke="var(--accent)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7.5 20C10.1 18.2 11.2 14.5 12 9.5C12.8 14.5 13.9 18.2 16.5 20"
            stroke="var(--accent)"
            strokeOpacity="0.48"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="12" cy="5" r="2" fill="var(--accent)" />
        </svg>
      </div>
      <div style={{ minWidth: 0 }}>
        <span className="brand-wordmark">Bifrost</span>
        {subtitle ? <span className="brand-subtitle">{subtitle}</span> : null}
      </div>
    </div>
  );
};
