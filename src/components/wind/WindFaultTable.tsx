/**
 * WindFaultTable - Table of wind turbine faults with filtering
 *
 * Features:
 * - Sortable columns
 * - Filter by status, severity, category
 * - Impact estimates (energy loss, cost, downtime)
 * - Expandable evidence details
 */

'use client';

import { useState, useMemo } from 'react';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  Zap,
  Filter,
} from 'lucide-react';
import type { WindFault, WindFaultCategory, WindFaultSeverity } from '@/types/wind';
import { getSeverityColor, getCategoryIcon } from '@/types/wind';

interface WindFaultTableProps {
  faults: WindFault[];
  onFilterChange?: (filters: {
    status?: string;
    severity?: string;
    category?: string;
  }) => void;
}

const severityOrder: Record<WindFaultSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export function WindFaultTable({
  faults,
  onFilterChange,
}: WindFaultTableProps) {
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [severityFilter, setSeverityFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Get unique categories from faults
  const categories = useMemo(() => {
    const cats = new Set(faults.map((f) => f.faultType.category));
    return Array.from(cats).sort();
  }, [faults]);

  // Filter and sort faults
  const filteredFaults = useMemo(() => {
    return faults
      .filter((f) => statusFilter === 'ALL' || f.status === statusFilter)
      .filter(
        (f) =>
          severityFilter === 'ALL' || f.faultType.severity === severityFilter
      )
      .filter(
        (f) =>
          categoryFilter === 'ALL' || f.faultType.category === categoryFilter
      )
      .sort((a, b) => {
        // Sort by severity first, then by date
        const sevDiff =
          severityOrder[a.faultType.severity] -
          severityOrder[b.faultType.severity];
        if (sevDiff !== 0) return sevDiff;
        return (
          new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
        );
      });
  }, [faults, statusFilter, severityFilter, categoryFilter]);

  const handleFilterChange = (
    type: 'status' | 'severity' | 'category',
    value: string
  ) => {
    const newFilters = {
      status: type === 'status' ? value : statusFilter,
      severity: type === 'severity' ? value : severityFilter,
      category: type === 'category' ? value : categoryFilter,
    };

    if (type === 'status') setStatusFilter(value);
    if (type === 'severity') setSeverityFilter(value);
    if (type === 'category') setCategoryFilter(value);

    onFilterChange?.({
      status: newFilters.status !== 'ALL' ? newFilters.status : undefined,
      severity: newFilters.severity !== 'ALL' ? newFilters.severity : undefined,
      category: newFilters.category !== 'ALL' ? newFilters.category : undefined,
    });
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            Fault Events
          </CardTitle>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={statusFilter} onValueChange={(v) => handleFilterChange('status', v)}>
              <SelectTrigger className="w-32 h-8">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Status</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="ACKNOWLEDGED">Acknowledged</SelectItem>
                <SelectItem value="RESOLVED">Resolved</SelectItem>
              </SelectContent>
            </Select>
            <Select value={severityFilter} onValueChange={(v) => handleFilterChange('severity', v)}>
              <SelectTrigger className="w-32 h-8">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Severity</SelectItem>
                <SelectItem value="CRITICAL">Critical</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="LOW">Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={(v) => handleFilterChange('category', v)}>
              <SelectTrigger className="w-36 h-8">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Categories</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Fault</TableHead>
                <TableHead>Turbine</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detected</TableHead>
                <TableHead className="text-right">Impact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredFaults.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    No faults match the selected filters
                  </TableCell>
                </TableRow>
              ) : (
                filteredFaults.map((fault) => {
                  const isExpanded = expandedIds.has(fault.id);
                  return (
                    <Collapsible key={fault.id} asChild open={isExpanded}>
                      <>
                        <TableRow className="cursor-pointer hover:bg-muted/50">
                          <TableCell>
                            <CollapsibleTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => toggleExpanded(fault.id)}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </Button>
                            </CollapsibleTrigger>
                          </TableCell>
                          <TableCell>
                            <div>
                              <div className="font-medium">{fault.faultType.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {fault.faultType.code} • {fault.faultType.category}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="font-medium">{fault.turbineId}</TableCell>
                          <TableCell>
                            <Badge
                              style={{
                                backgroundColor: getSeverityColor(fault.faultType.severity),
                                color: 'white',
                              }}
                            >
                              {fault.faultType.severity}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                fault.status === 'ACTIVE'
                                  ? 'destructive'
                                  : fault.status === 'RESOLVED'
                                  ? 'secondary'
                                  : 'outline'
                              }
                            >
                              {fault.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">
                              {format(parseISO(fault.detectedAt), 'MMM d, HH:mm')}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {formatDistanceToNow(parseISO(fault.detectedAt), {
                                addSuffix: true,
                              })}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-3 text-xs">
                              <span className="flex items-center gap-1">
                                <Zap className="h-3 w-3 text-yellow-600" />
                                {fault.estimatedImpact.lostEnergyKwh.toLocaleString()} kWh
                              </span>
                              <span className="flex items-center gap-1">
                                <DollarSign className="h-3 w-3 text-green-600" />
                                ${fault.estimatedImpact.repairCostUsd.toLocaleString()}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                        <CollapsibleContent asChild>
                          <TableRow className="bg-muted/30">
                            <TableCell colSpan={7} className="py-4">
                              <div className="grid grid-cols-1 gap-6 pl-4 sm:grid-cols-2 sm:pl-8">
                                <div>
                                  <h4 className="font-medium mb-2">Fault Details</h4>
                                  <p className="text-sm text-muted-foreground mb-3">
                                    {fault.faultType.description}
                                  </p>
                                  <div className="flex items-center gap-2 text-sm">
                                    <span className="text-muted-foreground">Confidence:</span>
                                    <Badge variant="outline">
                                      {(fault.confidence * 100).toFixed(0)}%
                                    </Badge>
                                  </div>
                                </div>
                                <div>
                                  <h4 className="font-medium mb-2">Evidence</h4>
                                  <div className="space-y-2">
                                    {fault.evidence.map((ev, idx) => (
                                      <div
                                        key={idx}
                                        className="flex items-center justify-between text-sm bg-background rounded p-2"
                                      >
                                        <span>{ev.indicator}</span>
                                        <span className="font-mono">
                                          {ev.value.toFixed(1)} / {ev.threshold}
                                          <span
                                            className={
                                              ev.deviation > 0
                                                ? 'text-red-600 ml-2'
                                                : 'text-green-600 ml-2'
                                            }
                                          >
                                            ({ev.deviation > 0 ? '+' : ''}
                                            {ev.deviation.toFixed(1)}%)
                                          </span>
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        </CollapsibleContent>
                      </>
                    </Collapsible>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
          <span>
            Showing {filteredFaults.length} of {faults.length} faults
          </span>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Total Downtime:{' '}
              {filteredFaults
                .reduce((sum, f) => sum + f.estimatedImpact.downtimeHours, 0)
                .toFixed(1)}h
            </span>
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" />
              Total Lost:{' '}
              {filteredFaults
                .reduce((sum, f) => sum + f.estimatedImpact.lostEnergyKwh, 0)
                .toLocaleString()}{' '}
              kWh
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default WindFaultTable;
