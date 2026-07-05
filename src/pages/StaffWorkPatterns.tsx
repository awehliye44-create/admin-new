import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertTriangle,
  Archive,
  CalendarDays,
  Copy,
  Edit,
  Loader2,
  Plus,
  RefreshCw,
  UserPlus,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ROLE_LABELS, StaffRole } from '@/hooks/useStaffProfile';
import {
  StaffWorkPatternFormDialog,
  StaffPatternFormValues,
} from '@/components/staffWorkPatterns/StaffWorkPatternFormDialog';
import {
  AssignableStaffMember,
  StaffPatternAssignDialog,
} from '@/components/staffWorkPatterns/StaffPatternAssignDialog';
import {
  buildDefaultSchedule,
  calculateWeeklyMinutes,
  DaySchedule,
  formatMinutesAsHours,
  shiftLengthLabel,
  summarizeWorkingDays,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
} from '../../shared/staffWorkPatternHours';
import {
  computeCoverageGaps,
  computePatternDashboardStats,
  countAssignedStaffForPattern,
  coverageGapMessage,
  CoverageGapRow,
  DAY_OF_WEEK_LABELS,
  patternHasCoverageGap,
  resolvePatternBadge,
  StaffWithPattern,
  StaffWorkPatternRow,
} from '@/lib/staffWorkPatternsModel';
import {
  CoverageRequirementFormValues,
  StaffCoverageRequirementDialog,
} from '@/components/staffWorkPatterns/StaffCoverageRequirementDialog';

type TabKey = 'staff' | 'patterns' | 'calendar' | 'coverage' | 'leave' | 'reports';

interface LeaveRow {
  id: string;
  staff_id: string;
  leave_date: string;
  leave_type: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  status: string;
  staff_name?: string;
}

function patternBadgeClass(badge: string): string {
  switch (badge) {
    case 'assigned':
      return 'bg-green-500/10 text-green-600 border-green-500/30';
    case 'open':
      return 'bg-yellow-500/10 text-yellow-700 border-yellow-500/30';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function parseSchedule(raw: unknown): DaySchedule[] {
  if (Array.isArray(raw) && raw.length > 0) return raw as DaySchedule[];
  return buildDefaultSchedule(true);
}

export default function StaffWorkPatterns() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as TabKey) || 'patterns';

  const [isLoading, setIsLoading] = useState(true);
  const [patterns, setPatterns] = useState<StaffWorkPatternRow[]>([]);
  const [staffMembers, setStaffMembers] = useState<StaffWithPattern[]>([]);
  const [assignableStaff, setAssignableStaff] = useState<AssignableStaffMember[]>([]);
  const [assignments, setAssignments] = useState<
    { pattern_id: string; staff_id: string; is_active: boolean }[]
  >([]);
  const [coverageRequirements, setCoverageRequirements] = useState<CoverageGapRow[]>([]);
  const [leaveRows, setLeaveRows] = useState<LeaveRow[]>([]);
  const [regions, setRegions] = useState<{ id: string; name: string }[]>([]);
  const [serviceAreas, setServiceAreas] = useState<
    { id: string; name: string; region_id: string | null }[]
  >([]);

  const [patternSearch, setPatternSearch] = useState('');
  const [staffSearch, setStaffSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'assigned' | 'open' | 'inactive'>('all');

  const [formOpen, setFormOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [editingPattern, setEditingPattern] = useState<StaffWorkPatternRow | null>(null);
  const [duplicatePattern, setDuplicatePattern] = useState<StaffWorkPatternRow | null>(null);
  const [assignPattern, setAssignPattern] = useState<StaffWorkPatternRow | null>(null);
  const [coverageDialogOpen, setCoverageDialogOpen] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [
        patternsRes,
        staffRes,
        assignmentsRes,
        requirementsRes,
        leaveRes,
        regionsRes,
        areasRes,
      ] = await Promise.all([
        supabase
          .from('staff_work_patterns')
          .select('*')
          .is('archived_at', null)
          .order('name'),
        supabase
          .from('staff_profiles')
          .select('id, staff_role_id, full_name, role, is_active, assigned_pattern_id')
          .order('full_name'),
        supabase
          .from('staff_pattern_assignments')
          .select('pattern_id, staff_id, is_active')
          .eq('is_active', true),
        supabase.from('staff_coverage_requirements').select('*').eq('is_active', true),
        supabase
          .from('staff_leave_exceptions')
          .select('*')
          .order('leave_date', { ascending: false })
          .limit(100),
        supabase.from('regions').select('id, name').order('name'),
        supabase.from('service_areas').select('id, name, region_id').order('name'),
      ]);

      if (patternsRes.error) throw patternsRes.error;
      if (staffRes.error) throw staffRes.error;
      if (assignmentsRes.error) throw assignmentsRes.error;
      if (requirementsRes.error) throw requirementsRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (regionsRes.error) throw regionsRes.error;
      if (areasRes.error) throw areasRes.error;

      const regionMap = new Map((regionsRes.data ?? []).map((r) => [r.id, r.name]));
      const areaMap = new Map((areasRes.data ?? []).map((a) => [a.id, a.name]));

      const assignmentRows = assignmentsRes.data ?? [];
      const staffData = staffRes.data ?? [];
      setAssignments(assignmentRows);

      const patternRows: StaffWorkPatternRow[] = (patternsRes.data ?? []).map((row) => {
        const assignedCount = countAssignedStaffForPattern(row.id, assignmentRows, staffData);
        return {
          ...(row as Omit<StaffWorkPatternRow, 'schedule' | 'assigned_staff_count' | 'badge'>),
          schedule: parseSchedule(row.schedule),
          region_name: row.region_id ? regionMap.get(row.region_id) ?? null : null,
          service_area_name: row.service_area_id
            ? areaMap.get(row.service_area_id) ?? null
            : null,
          assigned_staff_count: assignedCount,
          badge: resolvePatternBadge(row.is_active, assignedCount),
        };
      });
      setPatterns(patternRows);

      const patternNameById = new Map(patternRows.map((p) => [p.id, p.name]));
      const patternHoursById = new Map(patternRows.map((p) => [p.id, p.weekly_hours_minutes]));

      const staffIds = staffData.map((s) => s.id);
      let staffAreaMap = new Map<string, string[]>();
      if (staffIds.length > 0) {
        const { data: staffAreas } = await supabase
          .from('staff_service_areas')
          .select('staff_id, service_area_id, service_areas(name)')
          .in('staff_id', staffIds);
        staffAreaMap = (staffAreas ?? []).reduce((acc, row) => {
          const name =
            (row.service_areas as { name?: string } | null)?.name ?? 'Unknown area';
          const list = acc.get(row.staff_id) ?? [];
          list.push(name);
          acc.set(row.staff_id, list);
          return acc;
        }, new Map<string, string[]>());
      }

      const staffRows: StaffWithPattern[] = staffData.map((row) => ({
        id: row.id,
        staff_role_id: row.staff_role_id,
        full_name: row.full_name,
        role: row.role as StaffRole,
        is_active: row.is_active,
        assigned_pattern_id: row.assigned_pattern_id,
        pattern_name: row.assigned_pattern_id
          ? patternNameById.get(row.assigned_pattern_id) ?? null
          : null,
        region_name: null,
        service_area_names: staffAreaMap.get(row.id) ?? [],
        weekly_hours_minutes: row.assigned_pattern_id
          ? patternHoursById.get(row.assigned_pattern_id) ?? null
          : null,
      }));
      setStaffMembers(staffRows);
      setAssignableStaff(
        staffRows.map((s) => ({
          id: s.id,
          full_name: s.full_name,
          staff_role_id: s.staff_role_id,
          role: s.role,
          is_active: s.is_active,
        })),
      );

      const gaps = computeCoverageGaps(
        (requirementsRes.data ?? []).map((row) => ({
          ...row,
          staff_role: row.staff_role as StaffRole,
          region_name: row.region_id ? regionMap.get(row.region_id) ?? null : null,
          service_area_name: row.service_area_id
            ? areaMap.get(row.service_area_id) ?? null
            : null,
        })),
        patternRows,
        assignmentRows,
      );
      setCoverageRequirements(gaps);

      const staffNameMap = new Map(staffRows.map((s) => [s.id, s.full_name]));
      setLeaveRows(
        (leaveRes.data ?? []).map((row) => ({
          ...row,
          staff_name: staffNameMap.get(row.staff_id) ?? 'Unknown',
        })),
      );

      setRegions(regionsRes.data ?? []);
      setServiceAreas(areasRes.data ?? []);
    } catch (error) {
      console.error('[StaffWorkPatterns] load failed', error);
      toast.error('Failed to load staff work patterns');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const dashboardStats = useMemo(() => computePatternDashboardStats(patterns), [patterns]);

  const filteredPatterns = useMemo(() => {
    return patterns.filter((pattern) => {
      const matchesSearch =
        !patternSearch ||
        pattern.name.toLowerCase().includes(patternSearch.toLowerCase()) ||
        (pattern.region_name ?? '').toLowerCase().includes(patternSearch.toLowerCase());
      const matchesStatus =
        statusFilter === 'all' || pattern.badge === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [patterns, patternSearch, statusFilter]);

  const filteredStaff = useMemo(() => {
    return staffMembers.filter(
      (member) =>
        !staffSearch ||
        member.full_name.toLowerCase().includes(staffSearch.toLowerCase()) ||
        member.staff_role_id.toLowerCase().includes(staffSearch.toLowerCase()),
    );
  }, [staffMembers, staffSearch]);

  const assignedStaffIdsForPattern = useCallback(
    (patternId: string) =>
      assignments.filter((a) => a.pattern_id === patternId && a.is_active).map((a) => a.staff_id),
    [assignments],
  );

  const calendarColumns = useMemo(() => {
    const columns: Record<
      string,
      {
        day: string;
        entries: {
          pattern: StaffWorkPatternRow;
          daySchedule: DaySchedule;
          names: string[];
        }[];
      }
    > = {};

    for (const pattern of patterns.filter((p) => p.badge === 'assigned')) {
      const names = assignedStaffIdsForPattern(pattern.id)
        .map((id) => staffMembers.find((s) => s.id === id)?.full_name)
        .filter((name): name is string => Boolean(name));

      for (const day of pattern.schedule.filter((entry) => entry.enabled)) {
        if (!columns[day.day]) {
          columns[day.day] = { day: day.day, entries: [] };
        }
        columns[day.day].entries.push({ pattern, daySchedule: day, names });
      }
    }

    return WEEKDAY_KEYS.map((dayKey) => columns[dayKey] ?? { day: dayKey, entries: [] });
  }, [patterns, staffMembers, assignedStaffIdsForPattern]);

  const coverageSummary = useMemo(() => {
    const totalRequired = coverageRequirements.reduce(
      (sum, row) => sum + row.required_staff_count,
      0,
    );
    const totalScheduled = coverageRequirements.reduce(
      (sum, row) => sum + row.scheduled_staff_count,
      0,
    );
    const totalGap = totalRequired - totalScheduled;
    const coveragePct =
      totalRequired > 0 ? Math.round((totalScheduled / totalRequired) * 1000) / 10 : 100;
    return { totalRequired, totalScheduled, totalGap, coveragePct };
  }, [coverageRequirements]);

  const savePattern = async (values: StaffPatternFormValues, existingId?: string) => {
    const weeklyMinutes = calculateWeeklyMinutes(values.schedule);
    const payload = {
      name: values.name.trim(),
      pattern_type: values.pattern_type,
      timezone: values.timezone,
      description: values.description.trim() || null,
      shift_length_preset: values.shift_length_preset,
      schedule: values.schedule,
      weekly_hours_minutes: weeklyMinutes,
      staff_role: values.staff_role,
      region_id: values.region_id,
      service_area_id: values.service_area_id,
      is_active: values.is_active,
      effective_from: values.effective_from || null,
      effective_to: values.effective_to || null,
      updated_at: new Date().toISOString(),
    };

    if (existingId) {
      const { error } = await supabase
        .from('staff_work_patterns')
        .update(payload)
        .eq('id', existingId);
      if (error) throw error;
      toast.success('Work pattern updated');
    } else {
      const { error } = await supabase.from('staff_work_patterns').insert(payload);
      if (error) throw error;
      toast.success('Work pattern created (open until assigned)');
    }
    await loadData();
  };

  const saveAssignments = async (patternId: string, staffIds: string[]) => {
    const currentIds = assignedStaffIdsForPattern(patternId);
    const toAdd = staffIds.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !staffIds.includes(id));

    if (toAdd.length > 0) {
      const { error } = await supabase.from('staff_pattern_assignments').upsert(
        toAdd.map((staffId) => ({
          pattern_id: patternId,
          staff_id: staffId,
          is_active: true,
        })),
        { onConflict: 'pattern_id,staff_id' },
      );
      if (error) throw error;
    }

    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('staff_pattern_assignments')
        .update({ is_active: false })
        .eq('pattern_id', patternId)
        .in('staff_id', toRemove);
      if (error) throw error;
    }

    if (toRemove.length > 0) {
      const { error: clearError } = await supabase
        .from('staff_profiles')
        .update({ assigned_pattern_id: null })
        .in('id', toRemove)
        .eq('assigned_pattern_id', patternId);
      if (clearError) throw clearError;
    }

    if (staffIds.length > 0) {
      const { error: assignError } = await supabase
        .from('staff_profiles')
        .update({ assigned_pattern_id: patternId })
        .in('id', staffIds);
      if (assignError) throw assignError;
    }

    toast.success('Staff assignments saved');
    await loadData();
  };

  const saveCoverageRequirement = async (values: CoverageRequirementFormValues) => {
    const { error } = await supabase.from('staff_coverage_requirements').insert({
      shift_name: values.shift_name.trim(),
      staff_role: values.staff_role,
      day_of_week: values.day_of_week,
      start_time: values.start_time,
      end_time: values.end_time,
      required_staff_count: values.required_staff_count,
      region_id: values.region_id,
      service_area_id: values.service_area_id,
      is_active: true,
    });
    if (error) throw error;
    toast.success('Coverage requirement added');
    await loadData();
  };

  const archivePattern = async (pattern: StaffWorkPatternRow) => {
    const { error } = await supabase
      .from('staff_work_patterns')
      .update({ archived_at: new Date().toISOString(), is_active: false })
      .eq('id', pattern.id);
    if (error) {
      toast.error('Failed to archive pattern');
      return;
    }
    toast.success('Pattern archived');
    await loadData();
  };

  const setTab = (tab: TabKey) => {
    setSearchParams(tab === 'patterns' ? {} : { tab });
  };

  const openPatterns = patterns.filter((p) => p.badge === 'open');

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Staff Work Patterns</h1>
            <p className="text-muted-foreground">
              Manage internal ONECAB staff schedules, patterns, coverage, and leave. Drivers are
              excluded from this module.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void loadData()} disabled={isLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              onClick={() => {
                setEditingPattern(null);
                setDuplicatePattern(null);
                setFormOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Pattern
            </Button>
          </div>
        </div>

        {openPatterns.length > 0 && (
          <Alert variant="destructive" className="border-yellow-500/50 bg-yellow-500/5 text-yellow-800">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {openPatterns.length} open pattern{openPatterns.length === 1 ? '' : 's'} — not assigned
              to staff. Open patterns do not count toward coverage.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total patterns</CardDescription>
              <CardTitle className="text-3xl">{dashboardStats.total}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Assigned patterns</CardDescription>
              <CardTitle className="text-3xl text-green-600">{dashboardStats.assigned}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Open patterns</CardDescription>
              <CardTitle className="text-3xl text-yellow-600">{dashboardStats.open}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Inactive patterns</CardDescription>
              <CardTitle className="text-3xl text-muted-foreground">{dashboardStats.inactive}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabKey)}>
          <TabsList className="flex flex-wrap h-auto">
            <TabsTrigger value="staff">Staff</TabsTrigger>
            <TabsTrigger value="patterns">Patterns</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="coverage">Coverage</TabsTrigger>
            <TabsTrigger value="leave">Leave / Exceptions</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
          </TabsList>

          <TabsContent value="staff" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Internal staff
                </CardTitle>
                <CardDescription>
                  ONECAB staff profiles only — no drivers appear in this list.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  placeholder="Search staff..."
                  value={staffSearch}
                  onChange={(event) => setStaffSearch(event.target.value)}
                  className="max-w-sm"
                />
                {isLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Service areas</TableHead>
                        <TableHead>Work pattern</TableHead>
                        <TableHead>Weekly hours</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredStaff.map((member) => (
                        <TableRow key={member.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium">{member.full_name}</p>
                              <p className="text-xs text-muted-foreground">{member.staff_role_id}</p>
                            </div>
                          </TableCell>
                          <TableCell>{ROLE_LABELS[member.role]}</TableCell>
                          <TableCell>
                            {member.service_area_names.length
                              ? member.service_area_names.join(', ')
                              : 'All areas'}
                          </TableCell>
                          <TableCell>
                            {member.pattern_name ?? (
                              <span className="text-yellow-700">No pattern assigned</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {member.weekly_hours_minutes != null
                              ? formatMinutesAsHours(member.weekly_hours_minutes)
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <Badge variant={member.is_active ? 'default' : 'secondary'}>
                              {member.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="patterns" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Work patterns</CardTitle>
                <CardDescription>
                  Create, edit, and assign reusable shift patterns. Unassigned patterns show an Open
                  badge.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-3 md:flex-row">
                  <Input
                    placeholder="Search patterns..."
                    value={patternSearch}
                    onChange={(event) => setPatternSearch(event.target.value)}
                    className="max-w-sm"
                  />
                  <Select
                    value={statusFilter}
                    onValueChange={(value) =>
                      setStatusFilter(value as typeof statusFilter)
                    }
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="assigned">Assigned</SelectItem>
                      <SelectItem value="open">Open pattern</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {isLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pattern</TableHead>
                        <TableHead>Shift length</TableHead>
                        <TableHead>Working days</TableHead>
                        <TableHead>Weekly hours</TableHead>
                        <TableHead>Assigned staff</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPatterns.map((pattern) => (
                        <TableRow key={pattern.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium">{pattern.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {pattern.region_name ?? 'All regions'}
                                {pattern.service_area_name
                                  ? ` · ${pattern.service_area_name}`
                                  : ''}
                              </p>
                              {pattern.badge === 'open' && (
                                <p className="text-xs text-yellow-700 mt-1">
                                  Open pattern — not assigned to staff
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>{shiftLengthLabel(pattern.shift_length_preset)}</TableCell>
                          <TableCell>{summarizeWorkingDays(pattern.schedule)}</TableCell>
                          <TableCell>{formatMinutesAsHours(pattern.weekly_hours_minutes)}</TableCell>
                          <TableCell>{pattern.assigned_staff_count}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              <Badge variant="outline" className={patternBadgeClass(pattern.badge)}>
                                {pattern.badge === 'open'
                                  ? 'Open pattern'
                                  : pattern.badge === 'assigned'
                                    ? 'Assigned'
                                    : 'Inactive'}
                              </Badge>
                              {patternHasCoverageGap(pattern, coverageRequirements) && (
                                <Badge variant="destructive">Coverage gap</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Edit"
                                onClick={() => {
                                  setEditingPattern(pattern);
                                  setDuplicatePattern(null);
                                  setFormOpen(true);
                                }}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Assign staff"
                                onClick={() => {
                                  setAssignPattern(pattern);
                                  setAssignOpen(true);
                                }}
                              >
                                <UserPlus className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Duplicate"
                                onClick={() => {
                                  setEditingPattern(null);
                                  setDuplicatePattern(pattern);
                                  setFormOpen(true);
                                }}
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Archive"
                                onClick={() => void archivePattern(pattern)}
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="calendar" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CalendarDays className="h-5 w-5" />
                  Weekly schedule preview
                </CardTitle>
                <CardDescription>
                  Assigned staff patterns only. Open patterns are excluded from the calendar.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 md:grid-cols-7">
                  {calendarColumns.map((column) => (
                    <div key={column.day} className="rounded-lg border p-3 space-y-2">
                      <p className="font-semibold uppercase text-sm">
                        {WEEKDAY_LABELS[column.day as keyof typeof WEEKDAY_LABELS] ?? column.day}
                      </p>
                      {column.entries.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No shifts</p>
                      ) : (
                        column.entries.map((entry) => (
                          <div
                            key={`${entry.pattern.id}-${entry.daySchedule.start_time}`}
                            className="rounded-md bg-primary/10 p-2 text-xs space-y-1"
                          >
                            <p className="font-medium">{entry.pattern.name}</p>
                            <p>
                              {entry.daySchedule.start_time} – {entry.daySchedule.end_time}
                            </p>
                            <p className="text-muted-foreground">
                              {entry.names.join(', ') || 'Assigned staff'}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="coverage" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Coverage overview</CardTitle>
                  <CardDescription>
                    Required vs scheduled staff. Only assigned patterns count toward scheduled coverage.
                  </CardDescription>
                </div>
                <Button onClick={() => setCoverageDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add requirement
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                {coverageRequirements.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No coverage requirements yet. Add a requirement to detect staffing gaps.
                  </p>
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Shift</TableHead>
                          <TableHead>Role</TableHead>
                          <TableHead>Day</TableHead>
                          <TableHead>Required</TableHead>
                          <TableHead>Scheduled</TableHead>
                          <TableHead>Gap / Over</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {coverageRequirements.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>
                              <div>
                                <p className="font-medium">{row.shift_name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {row.start_time.slice(0, 5)} – {row.end_time.slice(0, 5)}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell>{ROLE_LABELS[row.staff_role]}</TableCell>
                            <TableCell>{DAY_OF_WEEK_LABELS[row.day_of_week]}</TableCell>
                            <TableCell>{row.required_staff_count}</TableCell>
                            <TableCell>{row.scheduled_staff_count}</TableCell>
                            <TableCell>
                              {row.has_gap ? (
                                <div className="space-y-1">
                                  <Badge variant="destructive">{row.coverage_gap > 0 ? `-${row.coverage_gap}` : row.coverage_gap}</Badge>
                                  <p className="text-xs text-red-600">
                                    {coverageGapMessage(row.coverage_gap)}
                                  </p>
                                </div>
                              ) : (
                                <Badge variant="outline" className="text-green-600 border-green-500/30">
                                  {row.coverage_gap}
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>

                    <div className="flex flex-wrap gap-4 rounded-lg border p-4 text-sm">
                      <span>Total required: {coverageSummary.totalRequired}</span>
                      <span>Total scheduled: {coverageSummary.totalScheduled}</span>
                      <span className={coverageSummary.totalGap > 0 ? 'text-red-600 font-semibold' : ''}>
                        Total gap: {coverageSummary.totalGap > 0 ? `-${coverageSummary.totalGap}` : coverageSummary.totalGap}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          coverageSummary.coveragePct < 90
                            ? 'border-orange-500/50 text-orange-700'
                            : 'border-green-500/50 text-green-700'
                        }
                      >
                        Coverage {coverageSummary.coveragePct}%
                      </Badge>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="leave" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Leave / exceptions</CardTitle>
                <CardDescription>Track approved and pending staff absences.</CardDescription>
              </CardHeader>
              <CardContent>
                {leaveRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No leave records yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Staff</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leaveRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{row.staff_name}</TableCell>
                          <TableCell>{row.leave_date}</TableCell>
                          <TableCell className="capitalize">{row.leave_type.replace(/_/g, ' ')}</TableCell>
                          <TableCell>
                            {row.start_time && row.end_time
                              ? `${row.start_time.slice(0, 5)} – ${row.end_time.slice(0, 5)}`
                              : 'All day'}
                          </TableCell>
                          <TableCell>{row.reason ?? '—'}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                row.status === 'approved'
                                  ? 'text-green-600 border-green-500/30'
                                  : 'text-orange-600 border-orange-500/30'
                              }
                            >
                              {row.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="reports" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Pattern reports</CardTitle>
                <CardDescription>Summary metrics for staffing patterns.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Open patterns</p>
                  <p className="text-2xl font-bold text-yellow-600">{dashboardStats.open}</p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Patterns created but not yet assigned to any staff member.
                  </p>
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Coverage gaps</p>
                  <p className="text-2xl font-bold text-red-600">
                    {coverageRequirements.filter((r) => r.has_gap).length}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Requirement rows where scheduled staff is below required count.
                  </p>
                </div>
                <div className="rounded-lg border p-4 md:col-span-2">
                  <p className="font-medium mb-2">Assigned pattern hours</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pattern</TableHead>
                        <TableHead>Staff count</TableHead>
                        <TableHead>Weekly hours</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {patterns
                        .filter((p) => p.badge === 'assigned')
                        .map((pattern) => (
                          <TableRow key={pattern.id}>
                            <TableCell>{pattern.name}</TableCell>
                            <TableCell>{pattern.assigned_staff_count}</TableCell>
                            <TableCell>{formatMinutesAsHours(pattern.weekly_hours_minutes)}</TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <StaffWorkPatternFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        pattern={editingPattern}
        duplicateFrom={duplicatePattern}
        regions={regions}
        serviceAreas={serviceAreas}
        onSubmit={async (values) => {
          await savePattern(values, editingPattern?.id);
        }}
      />

      <StaffPatternAssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        pattern={assignPattern}
        staffMembers={assignableStaff}
        assignedStaffIds={assignPattern ? assignedStaffIdsForPattern(assignPattern.id) : []}
        onSubmit={async (staffIds) => {
          if (!assignPattern) return;
          await saveAssignments(assignPattern.id, staffIds);
        }}
      />

      <StaffCoverageRequirementDialog
        open={coverageDialogOpen}
        onOpenChange={setCoverageDialogOpen}
        regions={regions}
        serviceAreas={serviceAreas}
        onSubmit={saveCoverageRequirement}
      />
    </AdminLayout>
  );
}
