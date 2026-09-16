import React from 'react';
import { Html, Head, Body, Container, Section, Heading, Text, Hr, Link } from '@react-email/components';

/**
 * Critical plant-alert email: one email per plant per evaluation run,
 * batching every newly triggered / escalated CRITICAL alert. Mirrors the
 * ScheduledReport template structure with a red accent.
 */

export interface AlertEmailAlert {
  kind: string;
  message: string;
  metricValue: number;
  threshold: number;
  /** "Per the manual" action distilled from equipment documentation. */
  guidance?: {
    text: string;
    sourceTitle: string;
    section: string;
  } | null;
}

interface AlertEmailProps {
  plantName: string;
  plantUrl: string;
  alerts: AlertEmailAlert[];
}

const KIND_LABEL: Record<string, string> = {
  SOILING_LOSS: 'Soiling loss',
  PERFORMANCE_RATIO: 'Performance ratio',
  DATA_STALE: 'Data feed stale',
  CRITICAL_FAULT: 'Critical fault',
  CONTRACT_OBLIGATION: 'Contract obligation',
};

const styles = {
  body: { backgroundColor: '#f1f5f9', fontFamily: 'Arial, sans-serif' },
  container: { margin: '0 auto', padding: '20px 0 48px', width: '580px' },
  header: { backgroundColor: '#dc2626', borderRadius: '8px 8px 0 0', padding: '32px 40px' },
  brandName: { color: '#ffffff', fontSize: '24px', fontWeight: 'bold' as const, margin: '0 0 4px' },
  brandTagline: { color: '#fecaca', fontSize: '13px', margin: 0 },
  content: { backgroundColor: '#ffffff', borderRadius: '0 0 8px 8px', padding: '32px 40px' },
  heading: { color: '#0f172a', fontSize: '18px', fontWeight: 'bold' as const, margin: '0 0 8px' },
  text: { color: '#475569', fontSize: '14px', lineHeight: '22px', margin: '0 0 16px' },
  alertRow: {
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    padding: '12px 16px',
    margin: '0 0 10px',
  },
  alertKind: { color: '#991b1b', fontSize: '12px', fontWeight: 'bold' as const, textTransform: 'uppercase' as const, margin: '0 0 2px' },
  alertMsg: { color: '#0f172a', fontSize: '14px', margin: 0 },
  guidance: { color: '#334155', fontSize: '13px', lineHeight: '19px', margin: '8px 0 0' },
  guidanceSource: { color: '#94a3b8', fontSize: '11px', margin: '2px 0 0' },
  cta: {
    backgroundColor: '#0f172a',
    borderRadius: '6px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '14px',
    fontWeight: 'bold' as const,
    padding: '10px 20px',
    textDecoration: 'none',
  },
  footer: { color: '#94a3b8', fontSize: '12px', margin: '16px 0 0' },
};

export default function AlertEmail({ plantName, plantUrl, alerts }: AlertEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.header}>
            <Text style={styles.brandName}>NuraVolt</Text>
            <Text style={styles.brandTagline}>Critical plant alert</Text>
          </Section>
          <Section style={styles.content}>
            <Heading style={styles.heading}>{plantName} needs attention</Heading>
            <Text style={styles.text}>
              {alerts.length === 1
                ? 'A critical threshold was crossed:'
                : `${alerts.length} critical thresholds were crossed:`}
            </Text>
            {alerts.map((a, i) => (
              <Section key={i} style={styles.alertRow}>
                <Text style={styles.alertKind}>{KIND_LABEL[a.kind] ?? a.kind}</Text>
                <Text style={styles.alertMsg}>{a.message}</Text>
                {a.guidance ? (
                  <>
                    <Text style={styles.guidance}>Per the manual: {a.guidance.text}</Text>
                    <Text style={styles.guidanceSource}>Source: {a.guidance.section}</Text>
                  </>
                ) : null}
              </Section>
            ))}
            <Hr />
            <Link href={plantUrl} style={styles.cta}>
              Open plant console
            </Link>
            <Text style={styles.footer}>
              You receive critical alerts for plants you have access to. Adjust
              thresholds and notifications under the plant&apos;s Settings tab.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
