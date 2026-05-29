import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Product {
  id: string;
  merchant_id: string;
  product_category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  image_source: 'uploaded' | 'ai_generated';
  image_approved: boolean;
  availability: boolean;
  attributes: any;
}

export default function MerchantDetail() {
  const { id } = useParams<{ id: string }>();
  const [merchant, setMerchant] = useState<any | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [credits, setCredits] = useState<number>(0);
  const [generations, setGenerations] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiTargetProduct, setAiTargetProduct] = useState<string>('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [creditsToAdd, setCreditsToAdd] = useState(10);

  const load = async () => {
    if (!id) return;
    const [{ data: m }, { data: p }, { data: c }, { data: cr }, { data: g }, { data: o }] = await Promise.all([
      supabase.from('merchants').select('*').eq('id', id).maybeSingle(),
      supabase.from('merchant_products').select('*').eq('merchant_id', id).order('created_at', { ascending: false }),
      supabase.from('merchant_product_categories').select('id,name').eq('merchant_id', id).order('sort_order'),
      supabase.from('merchant_ai_credits').select('credits_remaining').eq('merchant_id', id).maybeSingle(),
      supabase.from('merchant_ai_generations').select('*').eq('merchant_id', id).order('created_at', { ascending: false }).limit(50),
      supabase.from('trips' as any).select('id, total_fare, payment_status, status, created_at').eq('merchant_id' as any, id).order('created_at', { ascending: false }).limit(100),
    ]);
    setMerchant(m);
    setProducts((p as any) ?? []);
    setCategories((c as any) ?? []);
    setCredits(cr?.credits_remaining ?? 0);
    setGenerations(g ?? []);
    setOrders(o ?? []);
  };

  useEffect(() => { load(); }, [id]);

  const saveMerchant = async (patch: any) => {
    const { error } = await supabase.from('merchants').update(patch).eq('id', id!);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Saved' });
    load();
  };

  const generateAI = async () => {
    if (!aiPrompt) return;
    setAiGenerating(true);
    const { data, error } = await supabase.functions.invoke('generate-merchant-image', {
      body: { merchant_id: id, product_id: aiTargetProduct || null, prompt: aiPrompt },
    });
    setAiGenerating(false);
    if (error) return toast({ title: 'AI failed', description: error.message, variant: 'destructive' });
    if ((data as any)?.error) return toast({ title: 'AI failed', description: (data as any).message || (data as any).error, variant: 'destructive' });
    toast({ title: 'Image generated' });
    setAiPrompt('');
    load();
  };

  const addCredits = async () => {
    const { error } = await supabase.from('merchant_ai_credits').upsert({
      merchant_id: id!, credits_remaining: credits + creditsToAdd, updated_at: new Date().toISOString(),
    });
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: `${creditsToAdd} credits added` });
    load();
  };

  const approveImage = async (gen: any, approved: boolean) => {
    await supabase.from('merchant_ai_generations').update({ status: approved ? 'approved' : 'rejected' }).eq('id', gen.id);
    if (gen.product_id) {
      await supabase.from('merchant_products').update({ image_approved: approved }).eq('id', gen.product_id);
    }
    load();
  };

  const deleteProduct = async (pid: string) => {
    if (!confirm('Delete product?')) return;
    await supabase.from('merchant_products').delete().eq('id', pid);
    load();
  };

  const addCategory = async (name: string) => {
    if (!name) return;
    await supabase.from('merchant_product_categories').insert({ merchant_id: id!, name, sort_order: categories.length });
    load();
  };

  if (!merchant) return <AdminLayout title="Merchant"><div className="p-6 text-muted-foreground">Loading…</div></AdminLayout>;

  return (
    <AdminLayout title={merchant.business_name} description={`${merchant.category.toUpperCase()} merchant`}>
      <div className="p-6 space-y-4">
        <Link to="/merchants" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to merchants
        </Link>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="products">Menu / Products</TabsTrigger>
            <TabsTrigger value="hours">Opening Hours</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="ai">AI Images</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <Card>
              <CardHeader><CardTitle>Business</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div><div className="text-muted-foreground">Status</div><Badge>{merchant.status}</Badge></div>
                <div><div className="text-muted-foreground">Open</div>{merchant.is_open ? 'Yes' : 'No'}</div>
                <div><div className="text-muted-foreground">Category</div>{merchant.category}</div>
                <div><div className="text-muted-foreground">Owner</div>{merchant.owner_name ?? '—'}</div>
                <div><div className="text-muted-foreground">Phone</div>{merchant.phone ?? '—'}</div>
                <div><div className="text-muted-foreground">Email</div>{merchant.email ?? '—'}</div>
                <div className="col-span-2 md:col-span-3"><div className="text-muted-foreground">Address</div>{merchant.address ?? '—'}, {merchant.city ?? ''} {merchant.postcode ?? ''}</div>
                <div><div className="text-muted-foreground">Prep time</div>{merchant.prep_time_minutes} min</div>
                <div><div className="text-muted-foreground">Delivery radius</div>{merchant.delivery_radius_km} km</div>
                <div><div className="text-muted-foreground">Min order</div>£{merchant.min_order_amount}</div>
                <div><div className="text-muted-foreground">Commission</div>{merchant.commission_pct ?? 15}% {merchant.commission_pct === null && '(global)'}</div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="orders">
            <Card>
              <CardHeader>
                <CardTitle>Delivery Orders</CardTitle>
                <CardDescription>Reusing the existing booking system (booking_type = delivery).</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Order ID</TableHead><TableHead>Amount</TableHead>
                    <TableHead>Payment</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {orders.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No delivery orders yet</TableCell></TableRow>}
                    {orders.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="font-mono text-xs">{o.id.slice(0, 8)}</TableCell>
                        <TableCell>£{Number(o.total_fare ?? 0).toFixed(2)}</TableCell>
                        <TableCell>{o.payment_status ?? '—'}</TableCell>
                        <TableCell>{o.status}</TableCell>
                        <TableCell className="text-xs">{new Date(o.created_at).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="products" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Menu / Products</CardTitle>
                  <CardDescription className="capitalize">{merchant.category} catalog</CardDescription>
                </div>
                <Button onClick={() => { setEditingProduct(null); setProductDialogOpen(true); }}>
                  <Plus className="h-4 w-4" /> Add item
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <Label>Add product category/section</Label>
                    <Input placeholder="e.g. Starters, Beverages, Fragile parcels…" onKeyDown={(e) => {
                      if (e.key === 'Enter') { addCategory((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ''; }
                    }} />
                  </div>
                </div>
                {categories.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {categories.map((c) => <Badge key={c.id} variant="secondary">{c.name}</Badge>)}
                  </div>
                )}

                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Image</TableHead><TableHead>Name</TableHead><TableHead>Price</TableHead>
                    <TableHead>Availability</TableHead><TableHead>Image source</TableHead><TableHead></TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {products.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No products yet</TableCell></TableRow>}
                    {products.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>{p.image_url ? <img src={p.image_url} className="h-10 w-10 object-cover rounded" alt="" /> : <div className="h-10 w-10 bg-muted rounded" />}</TableCell>
                        <TableCell>
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-muted-foreground">{p.description}</div>
                        </TableCell>
                        <TableCell>£{Number(p.price).toFixed(2)}</TableCell>
                        <TableCell>
                          <Switch checked={p.availability} onCheckedChange={async (v) => {
                            await supabase.from('merchant_products').update({ availability: v }).eq('id', p.id); load();
                          }} />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">{p.image_source}{p.image_source === 'ai_generated' && !p.image_approved && ' (pending)'}</Badge>
                        </TableCell>
                        <TableCell className="space-x-1">
                          <Button size="sm" variant="ghost" onClick={() => { setEditingProduct(p); setProductDialogOpen(true); }}>Edit</Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteProduct(p.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="hours">
            <Card>
              <CardHeader><CardTitle>Opening hours</CardTitle></CardHeader>
              <CardContent>
                <Textarea
                  rows={8}
                  placeholder='JSON, e.g. {"mon":"09:00-21:00","tue":"09:00-21:00"}'
                  defaultValue={JSON.stringify(merchant.opening_hours ?? {}, null, 2)}
                  onBlur={(e) => {
                    try { saveMerchant({ opening_hours: JSON.parse(e.target.value) }); }
                    catch { toast({ title: 'Invalid JSON', variant: 'destructive' }); }
                  }}
                />
                <div className="flex items-center justify-between mt-4 border rounded-lg p-3">
                  <Label>Store open</Label>
                  <Switch checked={merchant.is_open} onCheckedChange={(v) => saveMerchant({ is_open: v })} />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="payments">
            <Card>
              <CardHeader><CardTitle>Payments</CardTitle><CardDescription>Reuses the existing ONECAB payment + wallet system. No separate payout engine.</CardDescription></CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Merchant payouts and driver wallet entries flow through the global commission workflow (default 15%) and the existing payout batches. See the Finance section.
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ai" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /> AI Image Generation</CardTitle>
                <CardDescription>1 credit = 1 generated image. Generate manually only.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between border rounded-lg p-3">
                  <div>
                    <div className="text-xs text-muted-foreground">Credits remaining</div>
                    <div className="text-2xl font-semibold text-primary">{credits}</div>
                  </div>
                  <div className="flex items-end gap-2">
                    <div>
                      <Label className="text-xs">Add credits</Label>
                      <Input type="number" className="w-24" value={creditsToAdd} onChange={(e) => setCreditsToAdd(Number(e.target.value))} />
                    </div>
                    <Button onClick={addCredits}>Add</Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Prompt</Label>
                  <Textarea rows={2} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="e.g. Photorealistic chicken biryani on a white plate, top-down" />
                  <div className="flex items-center gap-2">
                    <Select value={aiTargetProduct} onValueChange={setAiTargetProduct}>
                      <SelectTrigger className="w-[260px]"><SelectValue placeholder="Attach to product (optional)" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">— None —</SelectItem>
                        {products.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button onClick={generateAI} disabled={aiGenerating || !aiPrompt || credits < 1}>
                      <Sparkles className="h-4 w-4" /> {aiGenerating ? 'Generating…' : 'Generate AI Image'}
                    </Button>
                  </div>
                </div>

                <div>
                  <h3 className="font-medium mb-2">History</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {generations.length === 0 && <div className="text-sm text-muted-foreground">No generations yet</div>}
                    {generations.map((g) => (
                      <div key={g.id} className="border rounded-lg p-2 space-y-2">
                        {g.image_url
                          ? <img src={g.image_url} alt="" className="w-full aspect-square object-cover rounded" />
                          : <div className="w-full aspect-square bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">{g.status}</div>}
                        <div className="text-xs truncate" title={g.prompt}>{g.prompt}</div>
                        <Badge variant="outline" className="text-xs">{g.status}</Badge>
                        {g.status === 'completed' && (
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" className="flex-1" onClick={() => approveImage(g, true)}>Approve</Button>
                            <Button size="sm" variant="outline" className="flex-1" onClick={() => approveImage(g, false)}>Reject</Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <Card>
              <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Edit core business details from the merchant list (Edit action). Status changes (Approve / Reject / Suspend) are also done from the list.
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <ProductDialog
        open={productDialogOpen}
        onOpenChange={setProductDialogOpen}
        merchantId={id!}
        category={merchant.category}
        product={editingProduct}
        productCategories={categories}
        onSaved={() => { setProductDialogOpen(false); load(); }}
      />
    </AdminLayout>
  );
}

interface ProductDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  merchantId: string;
  category: string;
  product: Product | null;
  productCategories: { id: string; name: string }[];
  onSaved: () => void;
}

function ProductDialog({ open, onOpenChange, merchantId, category, product, productCategories, onSaved }: ProductDialogProps) {
  const [form, setForm] = useState<any>({ name: '', description: '', price: 0, availability: true, image_url: '', product_category_id: '', attributes: {} });

  useEffect(() => {
    if (product) setForm({ ...product, product_category_id: product.product_category_id ?? '', attributes: product.attributes ?? {} });
    else setForm({ name: '', description: '', price: 0, availability: true, image_url: '', product_category_id: '', attributes: {} });
  }, [product, open]);

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const setAttr = (k: string, v: any) => setForm((f: any) => ({ ...f, attributes: { ...f.attributes, [k]: v } }));

  const save = async () => {
    if (!form.name) return toast({ title: 'Name required', variant: 'destructive' });
    const payload = {
      merchant_id: merchantId,
      name: form.name,
      description: form.description || null,
      price: Number(form.price) || 0,
      availability: !!form.availability,
      image_url: form.image_url || null,
      product_category_id: form.product_category_id || null,
      attributes: form.attributes ?? {},
    };
    const { error } = product
      ? await supabase.from('merchant_products').update(payload).eq('id', product.id)
      : await supabase.from('merchant_products').insert(payload);
    if (error) return toast({ title: 'Failed', description: error.message, variant: 'destructive' });
    toast({ title: 'Saved' });
    onSaved();
  };

  const uploadImage = async (file: File) => {
    const path = `${merchantId}/${crypto.randomUUID()}-${file.name}`;
    const { error } = await supabase.storage.from('merchant-products').upload(path, file, { upsert: true });
    if (error) return toast({ title: 'Upload failed', description: error.message, variant: 'destructive' });
    const { data } = supabase.storage.from('merchant-products').getPublicUrl(path);
    setForm((f: any) => ({ ...f, image_url: data.publicUrl }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{product ? 'Edit item' : 'Add item'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><Label>Description</Label><Textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Price (£)</Label><Input type="number" value={form.price} onChange={(e) => set('price', e.target.value)} /></div>
            <div>
              <Label>Section</Label>
              <Select value={form.product_category_id} onValueChange={(v) => set('product_category_id', v)}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">— None —</SelectItem>
                  {productCategories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Type-specific attributes */}
          {category === 'grocery' && (
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Unit / weight</Label><Input value={form.attributes?.unit ?? ''} onChange={(e) => setAttr('unit', e.target.value)} /></div>
              <div><Label>Stock status</Label>
                <Select value={form.attributes?.stock ?? 'in_stock'} onValueChange={(v) => setAttr('stock', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in_stock">In stock</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="out">Out of stock</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {category === 'retail' && (
            <div><Label>Stock status</Label>
              <Select value={form.attributes?.stock ?? 'in_stock'} onValueChange={(v) => setAttr('stock', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="in_stock">In stock</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="out">Out of stock</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {category === 'pharmacy' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between border rounded p-2">
                <Label>Prescription required</Label>
                <Switch checked={!!form.attributes?.prescription_required} onCheckedChange={(v) => setAttr('prescription_required', v)} />
              </div>
              <div><Label>Stock status</Label>
                <Select value={form.attributes?.stock ?? 'in_stock'} onValueChange={(v) => setAttr('stock', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in_stock">In stock</SelectItem>
                    <SelectItem value="out">Out of stock</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {category === 'parcel' && (
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Parcel size</Label>
                <Select value={form.attributes?.parcel_size ?? 'small'} onValueChange={(v) => setAttr('parcel_size', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Small</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="large">Large</SelectItem>
                    <SelectItem value="documents">Documents</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between border rounded p-2">
                <Label>Fragile option</Label>
                <Switch checked={!!form.attributes?.fragile} onCheckedChange={(v) => setAttr('fragile', v)} />
              </div>
            </div>
          )}
          {category === 'food' && (
            <div><Label>Add-ons / options (comma separated)</Label>
              <Input value={(form.attributes?.addons ?? []).join(', ')}
                onChange={(e) => setAttr('addons', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
            </div>
          )}

          <div>
            <Label>Image</Label>
            <Input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); }} />
            {form.image_url && <img src={form.image_url} className="mt-2 h-24 w-24 object-cover rounded" alt="" />}
          </div>

          <div className="flex items-center justify-between border rounded p-2">
            <Label>Available</Label>
            <Switch checked={form.availability} onCheckedChange={(v) => set('availability', v)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
