'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';

interface IntegrationTile {
  name: string;
  logo?: string;
  caption?: string;
}

interface IntegrationGroup {
  title: string;
  blurb: string;
  tiles: IntegrationTile[];
}

const DETAIL_ANCHOR = '#data-sources';

const INTEGRATIONS: IntegrationGroup[] = [
  {
    title: 'Inverter Cloud APIs',
    blurb: 'For portfolios without full SCADA, we pull from the vendor portal.',
    tiles: [
      { name: 'Huawei FusionSolar', caption: 'OAuth2 · plants, devices, alarms' },
      { name: 'SMA Sunny Portal', caption: 'Per-plant credentials' },
      { name: 'SolarEdge', caption: 'Per-inverter resolution' },
      { name: 'Fronius Solar.web', caption: 'Live + archive via OAuth' },
      { name: 'Sungrow iSolarCloud', caption: 'Full device-tree ingestion' },
      { name: 'Enphase Enlighten', caption: 'Microinverter-level data' },
      { name: 'Oxel', caption: 'Utility-scale portal' },
      { name: '+ your brand', caption: 'On request · ~2-3 weeks' },
    ],
  },
  {
    title: 'Industrial Protocols',
    blurb: 'Direct plant-side connections over the control network.',
    tiles: [
      { name: 'Modbus TCP', caption: 'IP-based · default for modern plants' },
      { name: 'Modbus RTU', caption: 'Serial RS-485 via gateway' },
      { name: 'OPC-UA', caption: 'SCADA standard · cert auth' },
      { name: 'MQTT', caption: 'Pub/sub · rooftop & hybrid' },
      { name: 'IEC 61850', caption: 'Substation protocol · on request' },
    ],
  },
  {
    title: 'Time-Series Databases',
    blurb: 'Read directly from your existing telemetry store.',
    tiles: [
      {
        name: 'InfluxDB',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/c/c6/Influxdb_logo.svg',
        caption: 'Flux + InfluxQL · v1.x & v2.x',
      },
      { name: 'TimescaleDB', caption: 'Native hypertable queries' },
      { name: 'Prometheus', caption: 'Remote-read API' },
      { name: 'OSIsoft PI', caption: 'Enterprise PI Historian' },
    ],
  },
  {
    title: 'Files & Cloud Storage',
    blurb: 'For bootstrapping, archive backfills, or air-gapped sites.',
    tiles: [
      { name: 'CSV', caption: 'Schema auto-detection + mapping wizard' },
      { name: 'Parquet', caption: 'Bulk historical imports' },
      { name: 'SFTP drop', caption: 'Scheduled archive pickups' },
      {
        name: 'AWS S3',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/93/Amazon_Web_Services_Logo.svg',
        caption: 'Bucket subscriber',
      },
      {
        name: 'Google Cloud Storage',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/5/51/Google_Cloud_logo.svg',
        caption: 'Bucket subscriber',
      },
      {
        name: 'Azure Blob',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Microsoft_Azure_Logo.svg',
        caption: 'Container subscriber',
      },
    ],
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.04 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

const IntegrationsLogoGrid = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.1 });

  return (
    <section
      ref={ref}
      className="py-16 sm:py-20 bg-paper-2 border-y border-divider"
    >
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="max-w-3xl mx-auto text-center mb-12"
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6 }}
        >
          <div className="text-sm font-semibold text-primary uppercase tracking-wider mb-3">
            What we connect to
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-ink mb-4">
            If your stack speaks it, we ingest it.
          </h2>
          <p className="text-lg text-ink-2">
            Inverter cloud APIs, industrial protocols, time-series databases, and flat
            files, the four shapes utility-scale PV and BESS data actually arrives in.
          </p>
        </motion.div>

        <div className="space-y-12 max-w-6xl mx-auto">
          {INTEGRATIONS.map((group) => (
            <motion.div
              key={group.title}
              variants={containerVariants}
              initial="hidden"
              animate={isInView ? 'visible' : 'hidden'}
            >
              <div className="text-center mb-6">
                <a
                  href={DETAIL_ANCHOR}
                  className="text-xl font-bold text-ink hover:text-primary transition-colors"
                >
                  {group.title}
                </a>
                <p className="text-sm text-ink-3 mt-1">{group.blurb}</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {group.tiles.map((tile) => (
                  <motion.div
                    key={tile.name}
                    variants={itemVariants}
                    className="bg-paper rounded p-5 shadow-sm hover:shadow-sm transition-shadow flex flex-col items-center justify-center text-center min-h-[120px] border border-divider"
                  >
                    {tile.logo ? (
                      <>
                        <img
                          src={tile.logo}
                          alt={tile.name}
                          className="h-10 object-contain mb-3"
                          loading="lazy"
                        />
                        <div className="text-xs font-semibold text-ink-2">
                          {tile.name}
                        </div>
                      </>
                    ) : (
                      <div className="text-base font-bold text-primary mb-2 leading-tight">
                        {tile.name}
                      </div>
                    )}
                    {tile.caption && (
                      <div className="text-[11px] text-ink-3 leading-snug mt-1">
                        {tile.caption}
                      </div>
                    )}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>

        <motion.p
          className="mt-12 text-center text-sm text-ink-3 max-w-2xl mx-auto"
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : { opacity: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          Brand names and logos are the property of their respective owners and are shown
          here to indicate supported data sources. No endorsement or partnership is
          implied unless explicitly stated.
        </motion.p>
      </div>
    </section>
  );
};

export default IntegrationsLogoGrid;
