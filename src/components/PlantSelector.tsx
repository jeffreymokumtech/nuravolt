'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, MapPin, Sun, Wind, Battery, Sparkles } from 'lucide-react';
import { useAnonymization } from '@/contexts/AnonymizationContext';
import { useDemoPlants } from '@/contexts/DemoPlantContext';

type AssetType = 'SOLAR' | 'WIND' | 'BESS';

interface PlantData {
  plantId: string;
  plantName: string;
  location: string;
  capacity_MW: number;
  status: 'operational' | 'demo' | 'offline';
  assetType?: AssetType;
}

interface PlantSelectorProps {
  currentPlantId: string;
  onPlantChange: (plantId: string) => void;
  /** Base path for the "View All Plants" link. Defaults to `/demo`. */
  routePrefix?: '/demo' | '/showcase';
}

export default function PlantSelector({
  currentPlantId,
  onPlantChange,
  routePrefix = '/demo',
}: PlantSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { anonName, anonLocation } = useAnonymization();

  // Plants come from the API-backed context. useDemoPlants() is a plain
  // useContext read (with a default value), so it is safe to call
  // unconditionally; outside a DemoPlantProvider the selector renders empty.
  const demoPlants = useDemoPlants();
  const loading = demoPlants ? demoPlants.loading : false;
  const plants: PlantData[] = (demoPlants?.plants ?? []).map(p => ({
    plantId: p.slug,
    plantName: p.name,
    location: p.location_name || '',
    capacity_MW: p.capacity_mw,
    status: (p.status === 'OPERATIONAL' ? 'operational' : p.status === 'SUSPENDED' ? 'offline' : 'operational') as PlantData['status'],
    assetType: (p.asset_type === 'PV' ? 'SOLAR' : p.asset_type) as AssetType,
  }));

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Match by slug or id
  const currentPlant = plants.find(p => p.plantId === currentPlantId);

  // Status badge colors
  const statusColors = {
    operational: 'bg-green-100 text-green-700',
    demo: 'bg-gray-100 text-gray-500',
    offline: 'bg-red-100 text-red-700',
  };

  // Asset type icons and colors
  const assetTypeConfig: Record<AssetType, { icon: typeof Sun; color: string }> = {
    SOLAR: { icon: Sun, color: 'text-amber-500' },
    WIND: { icon: Wind, color: 'text-cyan-500' },
    BESS: { icon: Battery, color: 'text-green-500' },
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg animate-pulse">
        <div className="w-24 h-4 bg-gray-200 rounded"></div>
        <ChevronDown className="w-4 h-4 text-gray-400" />
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors min-w-[200px]"
      >
        <div className="flex-1 text-left">
          <div className="text-sm font-medium text-gray-900 truncate">
            {anonName(currentPlant?.plantName || 'Select Plant')}
          </div>
          {currentPlant && (
            <div className="text-xs text-gray-500 flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {anonLocation(currentPlant.location)}
            </div>
          )}
        </div>
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide px-2">
              Select Plant
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {plants.map((plant) => {
              const isSelected = plant.plantId === currentPlantId;
              const isDisabled = plant.status === 'demo';
              const isCustom = false; // All plants now come from API
              const assetType = plant.assetType || 'SOLAR';
              const { icon: AssetIcon, color: assetColor } = assetTypeConfig[assetType];

              return (
                <button
                  key={plant.plantId}
                  onClick={() => {
                    if (!isDisabled) {
                      onPlantChange(plant.plantId);
                      setIsOpen(false);
                    }
                  }}
                  disabled={isDisabled}
                  className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                    isSelected
                      ? 'bg-blue-50 border-l-4 border-blue-500'
                      : isDisabled
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-gray-50 border-l-4 border-transparent'
                  }`}
                >
                  <div className={`flex-shrink-0 ${assetColor}`}>
                    <AssetIcon className="w-5 h-5" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">
                        {anonName(plant.plantName)}
                      </span>
                      {isCustom ? (
                        <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-700 flex items-center gap-0.5">
                          <Sparkles className="w-3 h-3" />
                          New
                        </span>
                      ) : (
                        <span className={`px-1.5 py-0.5 text-xs font-medium rounded ${statusColors[plant.status]}`}>
                          {plant.status === 'operational' ? 'Live' : plant.status === 'demo' ? 'Demo' : 'Offline'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-gray-500 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {anonLocation(plant.location)}
                      </span>
                      <span className="text-xs text-gray-500">
                        {plant.capacity_MW} MW
                      </span>
                    </div>
                  </div>
                  {isSelected && (
                    <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
          {/* Portfolio link */}
          <div className="p-2 border-t border-gray-100 bg-gray-50">
            <a
              href={`${routePrefix}/portfolio`}
              className="flex items-center gap-2 px-3 py-2 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
              View All Plants
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
