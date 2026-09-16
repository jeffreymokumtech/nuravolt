import type {
  SavedScenarioData,
  CleaningParameters,
  LiveCostBenefitResult,
} from '@/types/soiling';

const STORAGE_KEY = 'nuravolt_cleaning_scenarios';

/**
 * Get all saved scenarios from localStorage
 */
export function getAllScenarios(): SavedScenarioData[] {
  if (typeof window === 'undefined') return [];

  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading scenarios:', error);
    return [];
  }
}

/**
 * Get scenarios for a specific plant
 */
export function getScenariosByPlant(plantId: string): SavedScenarioData[] {
  return getAllScenarios().filter((s) => s.plantId === plantId);
}

/**
 * Get a specific scenario by ID
 */
export function getScenarioById(id: string): SavedScenarioData | null {
  const scenarios = getAllScenarios();
  return scenarios.find((s) => s.id === id) || null;
}

/**
 * Save a new scenario or update existing one
 */
export function saveScenario(
  scenario: Omit<SavedScenarioData, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: string;
  }
): SavedScenarioData {
  const scenarios = getAllScenarios();
  const now = new Date().toISOString();

  const savedScenario: SavedScenarioData = {
    ...scenario,
    id: scenario.id || generateScenarioId(),
    createdAt: scenario.id
      ? scenarios.find((s) => s.id === scenario.id)?.createdAt || now
      : now,
    updatedAt: now,
  };

  const updatedScenarios = scenario.id
    ? scenarios.map((s) => (s.id === scenario.id ? savedScenario : s))
    : [...scenarios, savedScenario];

  localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedScenarios));

  return savedScenario;
}

/**
 * Delete a scenario
 */
export function deleteScenario(id: string): boolean {
  const scenarios = getAllScenarios();
  const filtered = scenarios.filter((s) => s.id !== id);

  if (filtered.length === scenarios.length) {
    return false; // Scenario not found
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  return true;
}

/**
 * Export scenario to JSON file
 */
export function exportScenarioToFile(scenario: SavedScenarioData): void {
  const dataStr = JSON.stringify(scenario, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `cleaning-scenario-${scenario.plantId}-${scenario.name.replace(/\s+/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Import scenario from JSON file
 */
export function importScenarioFromFile(
  file: File,
  onComplete: (scenario: SavedScenarioData) => void,
  onError: (error: string) => void
): void {
  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const content = e.target?.result as string;
      const imported = JSON.parse(content);

      // Validate structure
      if (
        !imported.plantId ||
        !imported.cleaningDates ||
        !imported.parameters ||
        !imported.result
      ) {
        throw new Error('Invalid scenario file structure');
      }

      // Generate new ID to avoid conflicts
      const scenario: SavedScenarioData = {
        ...imported,
        id: generateScenarioId(),
        name: `${imported.name} (imported)`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const saved = saveScenario(scenario);
      onComplete(saved);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Failed to import scenario');
    }
  };

  reader.onerror = () => {
    onError('Failed to read file');
  };

  reader.readAsText(file);
}

/**
 * Export all scenarios to JSON file
 */
export function exportAllScenarios(): void {
  const scenarios = getAllScenarios();
  const dataStr = JSON.stringify(scenarios, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `all-cleaning-scenarios-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Clear all scenarios (with confirmation)
 */
export function clearAllScenarios(): boolean {
  if (typeof window === 'undefined') return false;

  const confirmed = confirm(
    'Are you sure you want to delete all saved scenarios? This cannot be undone.'
  );

  if (confirmed) {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  }

  return false;
}

/**
 * Generate a unique scenario ID
 */
function generateScenarioId(): string {
  return `scenario_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Duplicate a scenario with a new name
 */
export function duplicateScenario(id: string, newName?: string): SavedScenarioData | null {
  const original = getScenarioById(id);
  if (!original) return null;

  const duplicate: Omit<SavedScenarioData, 'id' | 'createdAt' | 'updatedAt'> = {
    ...original,
    name: newName || `${original.name} (copy)`,
  };

  return saveScenario(duplicate);
}

/**
 * Get storage statistics
 */
export function getStorageStats(): {
  totalScenarios: number;
  byPlant: Record<string, number>;
  oldestScenario: string | null;
  newestScenario: string | null;
} {
  const scenarios = getAllScenarios();

  const byPlant: Record<string, number> = {};
  scenarios.forEach((s) => {
    byPlant[s.plantId] = (byPlant[s.plantId] || 0) + 1;
  });

  const sortedByDate = [...scenarios].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return {
    totalScenarios: scenarios.length,
    byPlant,
    oldestScenario: sortedByDate[0]?.createdAt || null,
    newestScenario: sortedByDate[sortedByDate.length - 1]?.createdAt || null,
  };
}
