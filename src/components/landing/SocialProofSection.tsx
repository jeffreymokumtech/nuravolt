'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';

const SocialProofSection = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const capabilities = [
    {
      value: '95%',
      label: 'Issue Detection Accuracy',
      color: 'text-blue-600'
    },
    {
      value: '2-4%',
      label: 'Typical Performance Recovery',
      color: 'text-blue-500'
    },
    {
      value: '8 weeks',
      label: 'Implementation Timeline',
      color: 'text-blue-400'
    },
    {
      value: '24/7',
      label: 'Monitoring Coverage',
      color: 'text-blue-600'
    }
  ];

  return null;
};

export default SocialProofSection;