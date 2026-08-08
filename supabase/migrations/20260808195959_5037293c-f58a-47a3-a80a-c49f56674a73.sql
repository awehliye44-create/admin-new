INSERT INTO public.content_items (app_scope, slug, title, content_html, status, version)
VALUES
  ('website', 'about_us', 'About Us (ONECAB.NET)', '<h1>About ONECAB</h1><p>Add your website about content here.</p>', 'draft', 1),
  ('website', 'privacy_policy', 'Privacy Policy (ONECAB.NET)', '<h1>Privacy Policy</h1><p>Add your website privacy policy here.</p>', 'draft', 1),
  ('website', 'terms_conditions', 'Terms & Conditions (ONECAB.NET)', '<h1>Terms &amp; Conditions</h1><p>Add your website terms here.</p>', 'draft', 1)
ON CONFLICT DO NOTHING;