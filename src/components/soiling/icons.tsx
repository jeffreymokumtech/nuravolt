/**
 * Professional icon mappings for Soiling Intelligence components
 * Replaces emoji icons with Heroicons for a more professional, enterprise-grade appearance
 */

import {
  Cog6ToothIcon,          // ⚙️ → Settings
  CurrencyEuroIcon,       // 💰 → Financial
  CalendarIcon,           // 📅 → Calendar
  ChartBarIcon,           // 📊 → Charts
  BeakerIcon,             // 🔬 → Optimization
  DocumentIcon,           // 📄 → Documents
  BookmarkIcon,           // 💾 → Save
  CloudIcon,              // 🌧️ → Rain
  InformationCircleIcon,  // ℹ️ → Info
  BoltIcon,               // ⚡ → Live/Fast
  SunIcon,                // ☀️ → Sun/Solar
} from '@heroicons/react/24/outline';

/**
 * Centralized icon mapping for consistent icon usage across all components
 */
export const SoilingIcons = {
  Settings: Cog6ToothIcon,
  Financial: CurrencyEuroIcon,
  Calendar: CalendarIcon,
  Charts: ChartBarIcon,
  Optimization: BeakerIcon,
  Document: DocumentIcon,
  Save: BookmarkIcon,
  Rain: CloudIcon,
  Info: InformationCircleIcon,
  Live: BoltIcon,
  Sun: SunIcon,
} as const;

/**
 * Icon size presets for consistent sizing
 */
export const IconSizes = {
  xs: 'w-3 h-3',
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
  xl: 'w-8 h-8',
} as const;

/**
 * Professional color palette for soiling intelligence components
 */
export const SoilingColors = {
  primary: {
    500: '#3B82F6',  // Blue - trust, reliability
    600: '#2563EB',
    700: '#1D4ED8',
  },
  neutral: {
    100: '#F3F4F6',
    200: '#E5E7EB',
    600: '#4B5563',
    900: '#111827',
  },
  status: {
    success: '#10B981',  // Green
    warning: '#F59E0B',  // Amber
    error: '#EF4444',    // Red
  },
  chart: {
    primary: '#3B82F6',    // Blue
    secondary: '#10B981',  // Green
    tertiary: '#F59E0B',   // Amber
  },
} as const;
