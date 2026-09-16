'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Star } from 'lucide-react';
import Image from 'next/image';

const testimonials = [
  {
    name: 'Ahmed Al Rashid',
    role: 'Operations Director',
    company: 'Dubai Solar Park',
    content: 'HeliosIQ helped us identify underperforming inverters that were costing us AED 2M annually. The ROI was achieved in just 3 months.',
    rating: 5,
    capacity: '800 MW'
  },
  {
    name: 'Sarah Mitchell',
    role: 'Asset Manager',
    company: 'Abu Dhabi Energy Corp',
    content: 'The predictive maintenance features have reduced our unplanned downtime by 75%. We can now schedule maintenance during low-generation periods.',
    rating: 5,
    capacity: '450 MW'
  },
  {
    name: 'Khalid bin Yousef',
    role: 'Technical Manager',
    company: 'Sharjah Solar Ventures',
    content: 'Real-time monitoring across our 12 sites has transformed our operations. The AI accurately predicted a major inverter failure, saving us millions.',
    rating: 5,
    capacity: '350 MW'
  }
];

const stats = [
  { value: '2.5 GW', label: 'Solar Capacity Monitored' },
  { value: '97%', label: 'Customer Retention Rate' },
  { value: 'AED 45M+', label: 'Revenue Recovered' },
  { value: '24/7', label: 'Uptime Guarantee' }
];

const TestimonialsSection = () => {
  return (
    <section className="py-16 sm:py-24 bg-gray-50">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center max-w-3xl mx-auto mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Trusted by Leading Solar Operators
          </h2>
          <p className="text-xl text-gray-600">
            See how HeliosIQ is transforming solar operations across the UAE
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
          {testimonials.map((testimonial) => (
            <Card key={testimonial.name} className="hover:shadow-lg transition-shadow">
              <CardContent className="p-6">
                <div className="flex mb-4">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <Star key={i} className="h-5 w-5 text-yellow-400 fill-current" />
                  ))}
                </div>
                
                <p className="text-gray-700 mb-6 italic">"{testimonial.content}"</p>
                
                <div className="border-t pt-4">
                  <div className="font-semibold text-gray-900">{testimonial.name}</div>
                  <div className="text-sm text-gray-600">{testimonial.role}</div>
                  <div className="text-sm text-gray-600">{testimonial.company}</div>
                  <div className="text-sm font-semibold text-blue-600 mt-1">
                    {testimonial.capacity} Portfolio
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="bg-blue-600 rounded-2xl p-8 md:p-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {stats.map((stat) => (
              <div key={stat.label}>
                <div className="text-3xl md:text-4xl font-bold text-white mb-2">
                  {stat.value}
                </div>
                <div className="text-blue-100">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 text-center">
          <h3 className="text-2xl font-bold text-gray-900 mb-8">
            Our Partners & Integrations
          </h3>
          <div className="flex flex-wrap justify-center items-center gap-8">
            {['SMA', 'Huawei', 'Sungrow', 'SolarEdge', 'Fronius'].map((partner) => (
              <div
                key={partner}
                className="bg-white px-6 py-3 rounded-lg shadow-sm text-gray-700 font-semibold"
              >
                {partner}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default TestimonialsSection;