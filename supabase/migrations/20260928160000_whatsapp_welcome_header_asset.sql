-- Public bucket for the WhatsApp welcome header image.
-- Meta fetches this URL when sending interactive image-header messages.

insert into storage.buckets (id, name, public)
values ('whatsapp-public', 'whatsapp-public', true)
on conflict (id) do update set public = true;

drop policy if exists "Public read WhatsApp welcome assets" on storage.objects;
create policy "Public read WhatsApp welcome assets"
  on storage.objects for select
  using (bucket_id = 'whatsapp-public');
