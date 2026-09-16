'use client';

import posthog from 'posthog-js';

/**
 * PostHog Analytics Utility for NuraVolt
 * Tracks key pilot program and user behavior metrics
 */

// ============================================
// LANDING PAGE TRACKING
// ============================================

export const trackPageView = (pageName: string, properties?: Record<string, any>) => {
  posthog.capture('$pageview', {
    page_name: pageName,
    ...properties
  });
};

export const trackSolutionInterest = (solutionType: 'PV Monitoring' | 'BESS Monitoring') => {
  posthog.capture('solution_interest', {
    solution_type: solutionType,
    timestamp: new Date().toISOString()
  });
};

export const trackCTAClick = (ctaName: string, ctaLocation: string) => {
  posthog.capture('cta_clicked', {
    cta_name: ctaName,
    cta_location: ctaLocation,
    timestamp: new Date().toISOString()
  });
};

// ============================================
// PILOT PROGRAM TRACKING
// ============================================

export const trackPilotSignupStarted = () => {
  posthog.capture('pilot_signup_started', {
    timestamp: new Date().toISOString()
  });
};

export const trackPilotSignupCompleted = (data: {
  companyName?: string;
  industry?: string;
  plantCapacity?: string;
  solutionType?: 'PV' | 'BESS' | 'Both';
}) => {
  posthog.capture('pilot_signup_completed', {
    ...data,
    timestamp: new Date().toISOString()
  });
};

export const trackDemoBooking = (source: 'header' | 'hero' | 'cta_section' | 'modal') => {
  posthog.capture('demo_booking_initiated', {
    source,
    timestamp: new Date().toISOString()
  });
};

export const trackCalendlyScheduled = () => {
  posthog.capture('calendly_demo_scheduled', {
    timestamp: new Date().toISOString()
  });
};

// ============================================
// USER ENGAGEMENT TRACKING
// ============================================

export const trackBlogPostView = (postSlug: string, postTitle: string) => {
  posthog.capture('blog_post_viewed', {
    post_slug: postSlug,
    post_title: postTitle,
    timestamp: new Date().toISOString()
  });
};

export const trackFAQInteraction = (question: string, expanded: boolean) => {
  posthog.capture('faq_interaction', {
    question,
    action: expanded ? 'expanded' : 'collapsed',
    timestamp: new Date().toISOString()
  });
};

export const trackPricingView = (scrollDepth: number) => {
  posthog.capture('pricing_section_viewed', {
    scroll_depth: scrollDepth,
    timestamp: new Date().toISOString()
  });
};

export const trackVideoPlay = (videoId: string, videoTitle: string) => {
  posthog.capture('video_played', {
    video_id: videoId,
    video_title: videoTitle,
    timestamp: new Date().toISOString()
  });
};

// ============================================
// AUTHENTICATION TRACKING
// ============================================

export const trackSignInAttempt = (method: 'email' | 'google' | 'microsoft') => {
  posthog.capture('sign_in_attempt', {
    method,
    timestamp: new Date().toISOString()
  });
};

export const trackSignInSuccess = (userId: string, userEmail?: string) => {
  posthog.identify(userId, {
    email: userEmail,
    signed_in_at: new Date().toISOString()
  });
  posthog.capture('sign_in_success', {
    timestamp: new Date().toISOString()
  });
};

export const trackSignUpCompleted = (userId: string, userEmail?: string, companyName?: string) => {
  posthog.identify(userId, {
    email: userEmail,
    company: companyName,
    signed_up_at: new Date().toISOString()
  });
  posthog.capture('sign_up_completed', {
    timestamp: new Date().toISOString()
  });
};

// ============================================
// DASHBOARD TRACKING (For when users access the platform)
// ============================================

export const trackDashboardFeatureUsed = (featureName: string, metadata?: Record<string, any>) => {
  posthog.capture('dashboard_feature_used', {
    feature_name: featureName,
    ...metadata,
    timestamp: new Date().toISOString()
  });
};

export const trackAlertGenerated = (alertData: {
  severity: 'info' | 'warning' | 'critical';
  alertType: string;
  plantId?: string;
}) => {
  posthog.capture('solar_alert_generated', {
    ...alertData,
    timestamp: new Date().toISOString()
  });
};

export const trackAlertAcknowledged = (alertId: string, responseTime: number) => {
  posthog.capture('alert_acknowledged', {
    alert_id: alertId,
    response_time_seconds: responseTime,
    timestamp: new Date().toISOString()
  });
};

export const trackROICalculationViewed = (estimatedSavings?: number) => {
  posthog.capture('roi_calculation_viewed', {
    estimated_savings: estimatedSavings,
    timestamp: new Date().toISOString()
  });
};

export const trackBESSMonitoringActivated = (batteryCapacity?: string) => {
  posthog.capture('bess_monitoring_activated', {
    battery_capacity: batteryCapacity,
    timestamp: new Date().toISOString()
  });
};

export const trackPVMonitoringActivated = (plantCapacity?: string) => {
  posthog.capture('pv_monitoring_activated', {
    plant_capacity: plantCapacity,
    timestamp: new Date().toISOString()
  });
};

// ============================================
// CONVERSION TRACKING
// ============================================

export const trackLeadCaptured = (leadSource: string, leadQuality?: 'hot' | 'warm' | 'cold') => {
  posthog.capture('lead_captured', {
    source: leadSource,
    quality: leadQuality,
    timestamp: new Date().toISOString()
  });
};

export const trackContactFormSubmitted = (formType: string) => {
  posthog.capture('contact_form_submitted', {
    form_type: formType,
    timestamp: new Date().toISOString()
  });
};

export const trackPilotToCustomerConversion = (userId: string, planType: string) => {
  posthog.capture('pilot_to_customer_conversion', {
    user_id: userId,
    plan_type: planType,
    timestamp: new Date().toISOString()
  });
};

// ============================================
// ERROR & SUPPORT TRACKING
// ============================================

export const trackError = (errorType: string, errorMessage: string, context?: Record<string, any>) => {
  posthog.capture('error_occurred', {
    error_type: errorType,
    error_message: errorMessage,
    ...context,
    timestamp: new Date().toISOString()
  });
};

export const trackSupportRequest = (requestType: string, userId?: string) => {
  posthog.capture('support_request_created', {
    request_type: requestType,
    user_id: userId,
    timestamp: new Date().toISOString()
  });
};

// ============================================
// USER PROPERTIES (For segmentation)
// ============================================

export const identifyUser = (userId: string, properties: {
  email?: string;
  name?: string;
  company?: string;
  role?: string;
  industry?: string;
  plantCapacity?: string;
  region?: string;
  plan?: 'pilot' | 'starter' | 'professional' | 'enterprise';
}) => {
  posthog.identify(userId, properties);
};

export const setUserProperties = (properties: Record<string, any>) => {
  posthog.people.set(properties);
};

// ============================================
// A/B TESTING & FEATURE FLAGS
// ============================================

export const getFeatureFlag = (flagName: string): boolean | string | undefined => {
  return posthog.getFeatureFlag(flagName);
};

export const isFeatureEnabled = (flagName: string): boolean => {
  return posthog.isFeatureEnabled(flagName);
};
