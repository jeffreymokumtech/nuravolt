'use client';

import { 
  BarChart3, 
  Settings2, 
  FileText, 
  Cloud, 
  ShieldCheck, 
  Cpu, 
  Database,
  Zap,
  Battery,
  Wind,
  Sun,
  CheckCircle2,
  Mail,
  Globe,
  ArrowRight,
  Activity,
  DollarSign,
  Monitor,
  PieChart,
  HardDrive,
  Search,
  TrendingUp
} from 'lucide-react';

export default function BrochurePage() {
  return (
    <div className="bg-paper-2 min-h-screen pb-12 font-sans text-ink">
      <style>{`
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; background-color: white !important; }
          .no-print { display: none !important; }
          .page-break { page-break-before: always; }
          @page { margin: 0; size: A4; }
          .brochure-container { max-width: 100% !important; padding: 0 !important; margin: 0 !important; box-shadow: none !important; }
        }
        
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
        
        body {
          font-family: 'Inter', sans-serif;
          -webkit-font-smoothing: antialiased;
        }
      `}</style>

      {/* Control Bar */}
      <div className="no-print sticky top-0 bg-paper/90 backdrop-blur-md border-b border-divider z-50 px-6 py-3 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-2 text-ink">
          <div className="w-8 h-8 bg-primary rounded flex items-center justify-center text-white font-bold text-lg leading-none text-center">N</div>
          <span className="font-bold tracking-tight">NuraVolt Solution Brief</span>
        </div>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-2 bg-primary hover:bg-primary text-white px-6 py-2.5 rounded-full text-sm font-bold shadow-sm transition-all hover:scale-105 active:scale-95"
        >
          <FileText className="w-4 h-4" />
          Save as PDF Brochure
        </button>
      </div>

      <div className="brochure-container max-w-[1000px] mx-auto bg-paper shadow-sm my-8 print:my-0 overflow-hidden">
        
        {/* ========== PAGE 1: STRATEGIC OVERVIEW ========== */}
        <div className="relative min-h-[1414px] flex flex-col">
          
          {/* Main Cover Section */}
          <div className="p-16 flex flex-col justify-center bg-data-bg text-white relative">
            <div className="absolute top-0 right-0 w-1/3 h-full opacity-10">
              <div className="absolute inset-0 border-l border-divider transform skew-x-12 translate-x-20" />
              <div className="absolute inset-0 border-l border-divider transform skew-x-12 translate-x-40" />
            </div>

            <div className="relative z-10 text-white">
              <div className="flex items-center gap-3 mb-16">
                <div className="w-12 h-12 bg-primary rounded flex items-center justify-center text-white font-black text-2xl shadow-sm">N</div>
                <span className="text-2xl font-black tracking-tighter">NURAVOLT</span>
              </div>
              
              <h1 className="text-7xl font-black mb-8 leading-[1.05] tracking-tight">
                Engineering <br />
                <span className="text-primary italic font-extrabold">Predictive</span> <br />
                Performance.
              </h1>
              
              <p className="text-2xl text-ink-3 max-w-2xl leading-relaxed mb-12 font-light text-ink-3">
                Physics-informed machine learning for <br />
                <span className="text-white font-semibold">Utility-Scale Solar, BESS, and Wind.</span>
              </p>

              <div className="flex flex-wrap gap-6 items-center">
                <div className="flex items-center gap-3 bg-paper/10 border border-white/20 px-6 py-3 rounded">
                  <Cloud className="w-6 h-6 text-primary" />
                  <div>
                    <div className="text-[10px] font-black uppercase tracking-widest text-ink-3">Option A</div>
                    <div className="text-sm font-bold">Cloud-Native SaaS</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 bg-paper/10 border border-white/20 px-6 py-3 rounded">
                  <ShieldCheck className="w-6 h-6 text-emerald-400" />
                  <div>
                    <div className="text-[10px] font-black uppercase tracking-widest text-ink-3">Option B</div>
                    <div className="text-sm font-bold">On-Premise / Edge</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Strategic Body: 2 Column Layout */}
          <div className="flex-1 flex p-16 gap-20 bg-paper">
            
            {/* Column 1: Financial & ROI */}
            <div className="w-1/2 flex flex-col space-y-12">
              <div>
                <h2 className="text-xs font-black text-primary uppercase tracking-[0.3em] mb-10 border-b border-divider pb-2">01 Portfolio Financials</h2>
                
                <div className="space-y-12">
                  <div className="flex gap-6 text-ink">
                    <div className="w-12 h-12 bg-paper-2 rounded flex-shrink-0 flex items-center justify-center text-primary border border-divider">
                      <DollarSign className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold mb-2 tracking-tight">ROI-Driven Diagnostics</h3>
                      <p className="text-sm text-ink-3 leading-relaxed font-medium">
                        Every technical anomaly is automatically assigned a dollar value. O&M teams prioritize work orders based on financial recovery potential rather than simple alarm counts.
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-6 text-ink">
                    <div className="w-12 h-12 bg-paper-2 rounded flex-shrink-0 flex items-center justify-center text-primary border border-divider">
                      <TrendingUp className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold mb-2 tracking-tight">Revenue Leakage Tracking</h3>
                      <p className="text-sm text-ink-3 leading-relaxed font-medium">
                        Continuous quantification of losses from soiling, inverter clipping, and thermal derating. Compare budget vs. actual performance across your entire portfolio.
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-6 text-ink">
                    <div className="w-12 h-12 bg-paper-2 rounded flex-shrink-0 flex items-center justify-center text-primary border border-divider">
                      <PieChart className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold mb-2 tracking-tight text-ink">Financial Reporting</h3>
                      <p className="text-sm text-ink-3 leading-relaxed font-medium">
                        Automated financial performance audits delivered to stakeholders. Clear visibility into the economic health of every asset in the portfolio.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Visual Metric Widget */}
              <div className="bg-paper-2 rounded-lg p-8 border border-divider mt-auto">
                <h4 className="text-[10px] font-black text-ink-3 uppercase tracking-widest mb-6 text-center">Average Portfolio Impact</h4>
                <div className="grid grid-cols-2 gap-8">
                  <div className="text-center">
                    <div className="text-4xl font-black text-primary italic leading-none">30%</div>
                    <div className="text-[9px] font-bold text-ink-3 uppercase mt-3">O&M Cost Savings</div>
                  </div>
                  <div className="text-center border-l border-divider">
                    <div className="text-4xl font-black text-signal-positive italic leading-none">92%</div>
                    <div className="text-[9px] font-bold text-ink-3 uppercase mt-3">Fault Accuracy</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Column 2: Operations & Intelligence */}
            <div className="w-1/2 flex flex-col space-y-12">
              <div>
                <h2 className="text-xs font-black text-primary uppercase tracking-[0.3em] mb-10 border-b border-indigo-100 pb-2">02 Operational Intelligence</h2>
                
                <div className="space-y-12">
                  <div className="flex gap-6 text-ink">
                    <div className="w-12 h-12 bg-indigo-50 rounded flex-shrink-0 flex items-center justify-center text-primary border border-indigo-100">
                      <Monitor className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold mb-2 tracking-tight text-ink">Per-Inverter Benchmarking</h3>
                      <p className="text-sm text-ink-3 leading-relaxed font-medium">
                        Peer-to-peer real-time analysis compares individual inverters against their neighbors. Identify subtle underperformance that fleet-wide averages miss.
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-6 text-ink">
                    <div className="w-12 h-12 bg-indigo-50 rounded flex-shrink-0 flex items-center justify-center text-primary border border-indigo-100">
                      <Search className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold mb-2 tracking-tight text-ink">Predictive Simulation</h3>
                      <p className="text-sm text-ink-3 leading-relaxed font-medium">
                        "What-if" modeling for maintenance. Run simulations to find the exact day when a cleaning or component replacement becomes financially optimal.
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-6 text-ink">
                    <div className="w-12 h-12 bg-indigo-50 rounded flex-shrink-0 flex items-center justify-center text-primary border border-indigo-100">
                      <Zap className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold mb-2 tracking-tight text-ink">Advanced Soiling Forecasts</h3>
                      <p className="text-sm text-ink-3 leading-relaxed font-medium">
                        365-day soiling intelligence with cleaning schedule optimization. Works without expensive on-site soiling sensors using climate physics.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Reporting Highlight */}
              <div className="bg-data-bg rounded-lg p-8 text-white relative overflow-hidden mt-auto">
                <FileText className="absolute -right-4 -bottom-4 w-32 h-32 text-white/5" />
                <h4 className="text-xs font-black text-primary uppercase tracking-widest mb-4">Autonomous Reporting</h4>
                <h3 className="text-xl font-extrabold mb-6 tracking-tight text-white uppercase">Intelligent Delivery</h3>
                <ul className="text-xs text-ink-3 space-y-4">
                  <li className="flex items-center gap-3 font-semibold text-data-fg-2 text-data-fg-2">
                    <CheckCircle2 className="w-4 h-4 text-primary" /> Daily Portfolio KPI Digests
                  </li>
                  <li className="flex items-center gap-3 font-semibold text-data-fg-2 text-data-fg-2">
                    <CheckCircle2 className="w-4 h-4 text-primary" /> Weekly Technical Deep-Dives
                  </li>
                  <li className="flex items-center gap-3 font-semibold text-data-fg-2 text-data-fg-2">
                    <CheckCircle2 className="w-4 h-4 text-primary" /> Monthly Compliance Audits
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* Footer Strip */}
          <div className="bg-paper-2 px-16 py-10 border-t border-divider flex items-center justify-between text-ink">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-data-bg rounded flex items-center justify-center text-white font-black text-[10px] leading-none text-center">N</div>
              <span className="text-xs font-black tracking-tight">NURAVOLT</span>
            </div>
            <div className="flex gap-12 text-[10px] font-black text-ink-3 uppercase tracking-[0.2em]">
              <span>nuravolt.com</span>
              <span>contact@nuravolt.com</span>
            </div>
          </div>
        </div>

        {/* ========== PAGE 2: ASSET DEPTH & INTEGRATION ========== */}
        <div className="page-break" />
        <div className="min-h-[1414px] p-16 flex flex-col bg-paper text-ink">
          
          <div className="mb-16">
            <h2 className="text-4xl font-black mb-4 tracking-tight uppercase text-ink">Technical Domain Depth</h2>
            <div className="h-1.5 bg-primary w-24 rounded-full" />
          </div>

          <div className="grid grid-cols-1 gap-8 mb-20">
            {/* Solar Detailed Card */}
            <div className="flex gap-12 items-stretch bg-paper-2 p-10 rounded-[40px] border border-divider">
              <div className="w-1/3 flex flex-col justify-between">
                <div>
                  <div className="bg-amber-500 w-16 h-16 rounded-[24px] flex items-center justify-center text-white shadow-sm mb-6">
                    <Sun className="w-8 h-8" />
                  </div>
                  <h3 className="text-2xl font-black mb-2 uppercase tracking-tighter text-ink text-nowrap text-ink">Solar PV Intelligence</h3>
                  <p className="text-xs font-bold text-signal-warning uppercase tracking-widest">Asset Management</p>
                </div>
                <div className="mt-8 text-5xl font-black text-data-fg-2">01</div>
              </div>
              <div className="w-2/3 grid grid-cols-1 gap-6 py-2">
                {[
                  { t: "String-Level Monitoring", d: "Granular detection of individual string outages or connector faults across the portfolio." },
                  { t: "Predictive Maintenance", d: "Detect insulation degradation and arc fault precursors 21 days earlier than SCADA alarms." },
                  { t: "Thermal Performance", d: "Monitor inverter cooling efficiency vs. ambient climate patterns to prevent derating losses." },
                  { t: "Soiling Recovery", d: "Determine the exact financial break-even point for cleaning interventions." }
                ].map((item, i) => (
                  <div key={i} className="flex gap-4">
                    <CheckCircle2 className="w-5 h-5 text-signal-warning shrink-0" />
                    <div>
                      <h4 className="text-sm font-black mb-1 uppercase tracking-tight text-ink">{item.t}</h4>
                      <p className="text-[11px] text-ink-3 leading-snug font-medium">{item.d}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* BESS Detailed Card */}
            <div className="flex gap-12 items-stretch bg-paper-2 p-10 rounded-[40px] border border-divider">
              <div className="w-1/3 flex flex-col justify-between">
                <div>
                  <div className="bg-signal-positive w-16 h-16 rounded-[24px] flex items-center justify-center text-white shadow-sm mb-6">
                    <Battery className="w-8 h-8" />
                  </div>
                  <h3 className="text-2xl font-black mb-2 uppercase tracking-tighter text-ink text-nowrap text-ink">Battery Storage Core</h3>
                  <p className="text-xs font-bold text-signal-positive uppercase tracking-widest">Physics-ML Engine</p>
                </div>
                <div className="mt-8 text-5xl font-black text-data-fg-2">02</div>
              </div>
              <div className="w-2/3 grid grid-cols-1 gap-6 py-2 text-ink">
                {[
                  { t: "SOH Accuracy < 1%", d: "Physics-informed ML models for hyper-accurate State of Health estimation without capacity tests." },
                  { t: "Safety Monitoring", d: "Early detection of thermal runaway precursors via voltage and temperature drift analysis." },
                  { t: "Warranty Compliance", d: "Automated tracking of EFC, throughput, and thermal limits for insurance compliance." },
                  { t: "Dispatch Optimization", d: "Maximize arbitrage revenue while minimizing cycle-based degradation costs." }
                ].map((item, i) => (
                  <div key={i} className="flex gap-4 text-ink">
                    <CheckCircle2 className="w-5 h-5 text-signal-positive shrink-0" />
                    <div>
                      <h4 className="text-sm font-black mb-1 uppercase tracking-tight text-ink">{item.t}</h4>
                      <p className="text-[11px] text-ink-3 leading-snug font-medium">{item.d}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Integration & Next Steps */}
          <div className="grid grid-cols-2 gap-16 items-start mt-auto">
            <div>
              <h3 className="text-[10px] font-black text-ink-3 uppercase tracking-[0.3em] mb-10 text-ink-3">System Architecture</h3>
              <div className="space-y-10">
                <div className="flex items-start gap-5">
                  <div className="bg-data-bg p-3 rounded text-white shadow-sm flex-shrink-0">
                    <Monitor className="w-6 h-6" />
                  </div>
                  <div>
                    <h4 className="text-sm font-black mb-2 uppercase tracking-tight text-ink">Works With or Without SCADA</h4>
                    <p className="text-[11px] text-ink-3 leading-relaxed font-medium">
                      Have SCADA? We layer on top as a predictive intelligence engine. No SCADA? We connect directly to inverter cloud APIs (Huawei, SMA, Sungrow, Fronius, SolarEdge, Enphase, Oxel).
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-5">
                  <div className="bg-data-bg p-3 rounded text-white shadow-sm flex-shrink-0">
                    <HardDrive className="w-6 h-6" />
                  </div>
                  <div>
                    <h4 className="text-sm font-black mb-2 uppercase tracking-tight text-ink">Data Sovereignty</h4>
                    <p className="text-[11px] text-ink-3 leading-relaxed font-medium">
                      On-premise deployment options for 100% data control. Our "Edge" nodes process data locally before secure synchronization.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-primary rounded-[40px] p-12 text-white shadow-sm relative overflow-hidden">
              <h3 className="text-3xl font-black mb-6 tracking-tighter italic uppercase text-white">Ready to Pilot?</h3>
              <p className="text-sm text-data-fg-2 leading-relaxed mb-10 font-medium italic opacity-90 text-data-fg-2">
                &ldquo;We ingest your historical data and deliver a full portfolio ROI projection in under 14 business days.&rdquo;
              </p>
              <div className="space-y-4 mb-10">
                <div className="flex items-center gap-4 text-xs font-black bg-paper/10 px-5 py-4 rounded border border-white/10 shadow-inner">
                  <BarChart3 className="w-5 h-5 text-data-fg-2" /> Complimentary Data Health Audit
                </div>
                <div className="flex items-center gap-4 text-xs font-black bg-paper/10 px-5 py-4 rounded border border-white/10 shadow-inner">
                  <Zap className="w-5 h-5 text-data-fg-2" /> Performance Validation Pilot
                </div>
              </div>
              <div className="pt-8 flex justify-between items-center group cursor-pointer border-t border-white/20">
                <span className="text-sm font-black uppercase tracking-[0.2em] text-white">Contact Engineering</span>
                <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform text-white" />
              </div>
            </div>
          </div>

          {/* Final Footer Branding */}
          <div className="mt-20 flex items-center justify-between border-t border-divider pt-12 text-ink">
            <div className="flex items-center gap-4 text-ink">
              <div className="w-12 h-12 bg-primary rounded flex items-center justify-center text-white font-black text-2xl shadow-sm leading-none text-center">N</div>
              <div>
                <h1 className="text-xl font-black leading-none tracking-tighter uppercase text-ink">NURAVOLT</h1>
                <p className="text-[10px] text-ink-3 uppercase tracking-[0.2em] mt-1.5 font-bold text-ink-3">Specialized Energy Intelligence</p>
              </div>
            </div>
            <div className="flex gap-16 text-right">
              <div className="space-y-1">
                <p className="text-[10px] font-black text-ink-3 uppercase tracking-widest text-ink-3">Digital</p>
                <p className="text-sm font-black text-ink uppercase">nuravolt.com</p>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-black text-ink-3 uppercase tracking-widest text-ink-3">Inquiries</p>
                <p className="text-sm font-black text-ink uppercase">contact@nuravolt.com</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
