import React from 'react';
import { Html, Head, Body, Container, Section, Text, Link, Preview } from '@react-email/components';

interface EmailTemplateProps {
  email: string;
}

const styles = {
  body: {
    backgroundColor: '#f3f4f6',
    fontFamily: 'Arial, sans-serif',
  },
  container: {
    margin: '0 auto',
    padding: '20px 0 48px',
    width: '580px',
  },
  section: {
    backgroundColor: '#ffffff',
    borderRadius: '5px',
    padding: '40px',
  },
  h1: {
    color: '#3b82f6',
    fontSize: '32px',
    fontWeight: 'bold',
    textAlign: 'center' as const,
    margin: '0 0 20px',
  },
  text: {
    color: '#374151',
    fontSize: '16px',
    lineHeight: '24px',
    textAlign: 'center' as const,
  },
  button: {
    backgroundColor: '#3b82f6',
    borderRadius: '5px',
    color: '#ffffff',
    display: 'inline-block',
    fontSize: '16px',
    fontWeight: 'bold',
    padding: '12px 24px',
    textDecoration: 'none',
    textAlign: 'center' as const,
    marginTop: '32px',
  },
};

const ThankYouTemplate: React.FC<Readonly<EmailTemplateProps>> = ({
  email,
}) => (
  <Html>
    <Head />
    <Preview>Welcome to our community!</Preview>
    <Body style={styles.body}>
      <Container style={styles.container}>
        <Section style={styles.section}>
          <Text style={styles.h1}>Welcome aboard!</Text>
          <Text style={styles.text}>
            We&apos;re thrilled to have you join us, {email}!
          </Text>
          <Text style={styles.text}>
            Get ready for an amazing journey. We can&apos;t wait to see what you&apos;ll achieve with us.
          </Text>
          <Section style={{ textAlign: 'center' }}>
            <Link
              href="http://localhost:3000/dashboard"
              style={styles.button}
            >
              Get Started
            </Link>
          </Section>
        </Section>
      </Container>
    </Body>
  </Html>
);

export default ThankYouTemplate;