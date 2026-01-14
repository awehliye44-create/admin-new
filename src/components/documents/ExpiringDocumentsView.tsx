import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useExpiringDocuments,
  useExpiredDocuments,
  useDocumentExpiryStats,
} from "@/hooks/useExpiringDocuments";
import {
  AlertTriangle,
  Clock,
  Search,
  Loader2,
  Calendar,
  FileX,
  FileCheck,
  User,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";

export function ExpiringDocumentsView() {
  const [daysFilter, setDaysFilter] = useState("30");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: stats, isLoading: statsLoading } = useDocumentExpiryStats();
  const {
    data: expiringDocs,
    isLoading: expiringLoading,
    refetch: refetchExpiring,
  } = useExpiringDocuments(parseInt(daysFilter));
  const {
    data: expiredDocs,
    isLoading: expiredLoading,
    refetch: refetchExpired,
  } = useExpiredDocuments();

  const filterDocuments = (docs: typeof expiringDocs) => {
    if (!docs) return [];
    if (!searchQuery) return docs;
    const query = searchQuery.toLowerCase();
    return docs.filter(
      (doc) =>
        doc.document_name.toLowerCase().includes(query) ||
        doc.driver?.first_name?.toLowerCase().includes(query) ||
        doc.driver?.last_name?.toLowerCase().includes(query)
    );
  };

  const getUrgencyBadge = (daysUntil: number) => {
    if (daysUntil <= 0) {
      return (
        <Badge variant="destructive">
          <FileX className="h-3 w-3 mr-1" />
          Expired
        </Badge>
      );
    }
    if (daysUntil <= 3) {
      return (
        <Badge variant="destructive">
          <AlertTriangle className="h-3 w-3 mr-1" />
          {daysUntil} day{daysUntil !== 1 ? "s" : ""} left
        </Badge>
      );
    }
    if (daysUntil <= 7) {
      return (
        <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">
          <Clock className="h-3 w-3 mr-1" />
          {daysUntil} days left
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="bg-yellow-50 text-yellow-700">
        <Calendar className="h-3 w-3 mr-1" />
        {daysUntil} days left
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Expired</p>
                <p className="text-2xl font-bold text-red-600">
                  {statsLoading ? "..." : stats?.expired || 0}
                </p>
              </div>
              <FileX className="h-8 w-8 text-red-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-orange-500/30 bg-orange-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Expiring in 7 Days</p>
                <p className="text-2xl font-bold text-orange-600">
                  {statsLoading ? "..." : stats?.expiringIn7Days || 0}
                </p>
              </div>
              <AlertTriangle className="h-8 w-8 text-orange-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Expiring in 30 Days</p>
                <p className="text-2xl font-bold text-yellow-600">
                  {statsLoading ? "..." : stats?.expiringIn30Days || 0}
                </p>
              </div>
              <Clock className="h-8 w-8 text-yellow-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Documents Tracked</p>
                <p className="text-2xl font-bold text-green-600">
                  {statsLoading ? "..." : stats?.total || 0}
                </p>
              </div>
              <FileCheck className="h-8 w-8 text-green-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs for Expiring / Expired */}
      <Tabs defaultValue="expiring" className="space-y-4">
        <TabsList>
          <TabsTrigger value="expiring" className="gap-2">
            <Clock className="h-4 w-4" />
            Expiring Soon
            {stats && stats.expiringIn7Days > 0 && (
              <Badge variant="destructive" className="ml-1">
                {stats.expiringIn7Days}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="expired" className="gap-2">
            <FileX className="h-4 w-4" />
            Expired
            {stats && stats.expired > 0 && (
              <Badge variant="destructive" className="ml-1">
                {stats.expired}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="expiring">
          <Card>
            <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-orange-500" />
                  Expiring Soon
                </CardTitle>
                <CardDescription>
                  Documents expiring within the next {daysFilter} days
                </CardDescription>
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search..."
                    className="pl-9 w-full md:w-[180px]"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Select value={daysFilter} onValueChange={setDaysFilter}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">Next 7 days</SelectItem>
                    <SelectItem value="14">Next 14 days</SelectItem>
                    <SelectItem value="30">Next 30 days</SelectItem>
                    <SelectItem value="60">Next 60 days</SelectItem>
                    <SelectItem value="90">Next 90 days</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => refetchExpiring()}
                  disabled={expiringLoading}
                >
                  <RefreshCw className={`h-4 w-4 ${expiringLoading ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {expiringLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : filterDocuments(expiringDocs).length === 0 ? (
                <div className="py-12 text-center">
                  <FileCheck className="h-12 w-12 text-green-500 mx-auto mb-4" />
                  <h3 className="text-lg font-medium mb-2">No expiring documents</h3>
                  <p className="text-muted-foreground">
                    All documents are valid beyond {daysFilter} days
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead>Expiry Date</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filterDocuments(expiringDocs).map((doc) => (
                      <TableRow key={doc.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="font-medium">
                                {doc.driver?.first_name} {doc.driver?.last_name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {doc.driver?.phone}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{doc.document_name}</TableCell>
                        <TableCell>
                          {doc.expiry_date && format(new Date(doc.expiry_date), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell>{getUrgencyBadge(doc.days_until_expiry)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expired">
          <Card>
            <CardHeader className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileX className="h-5 w-5 text-red-500" />
                  Expired Documents
                </CardTitle>
                <CardDescription>
                  Documents that have already expired and need renewal
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => refetchExpired()}
                disabled={expiredLoading}
              >
                <RefreshCw className={`h-4 w-4 ${expiredLoading ? "animate-spin" : ""}`} />
              </Button>
            </CardHeader>
            <CardContent>
              {expiredLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : expiredDocs?.length === 0 ? (
                <div className="py-12 text-center">
                  <FileCheck className="h-12 w-12 text-green-500 mx-auto mb-4" />
                  <h3 className="text-lg font-medium mb-2">No expired documents</h3>
                  <p className="text-muted-foreground">All documents are currently valid</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Driver</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead>Expired On</TableHead>
                      <TableHead>Days Overdue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expiredDocs?.map((doc) => (
                      <TableRow key={doc.id} className="bg-red-50/50">
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="font-medium">
                                {doc.driver?.first_name} {doc.driver?.last_name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {doc.driver?.phone}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{doc.document_name}</TableCell>
                        <TableCell>
                          {doc.expiry_date && format(new Date(doc.expiry_date), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell>
                          <Badge variant="destructive">
                            {Math.abs(doc.days_until_expiry)} days overdue
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
      </Tabs>
    </div>
  );
}
