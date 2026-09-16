import React from 'react';

interface HoneypotFieldProps {
  name?: string;
  value: string;
  onChange: (value: string) => void;
}

const HoneypotField: React.FC<HoneypotFieldProps> = ({ 
  name = 'website', 
  value, 
  onChange 
}) => {
  return (
    <div 
      style={{
        position: 'absolute',
        left: '-9999px',
        width: '1px',
        height: '1px',
        overflow: 'hidden'
      }}
      aria-hidden="true"
    >
      <label htmlFor={name}>
        Leave this field empty
      </label>
      <input
        type="text"
        id={name}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
      />
    </div>
  );
};

export default HoneypotField;