
UPDATE content_items SET content_html = '<h1>About OneCab</h1>
<p>OneCab is a modern ride-hailing service connecting passengers with professional licensed drivers across the UK. We are committed to providing safe, reliable, and affordable transportation.</p>
<h2>Our Mission</h2>
<p>To deliver the best ride experience through technology, transparency, and trust. Whether you need a quick trip across town or a scheduled airport transfer, OneCab has you covered.</p>
<h2>Why Choose OneCab?</h2>
<ul>
<li>All drivers are fully licensed and vetted</li>
<li>Transparent upfront pricing with no hidden fees</li>
<li>24/7 customer support</li>
<li>Real-time trip tracking for your safety</li>
<li>Multiple payment options including cash and card</li>
</ul>
<h2>Contact Us</h2>
<p>Phone: 01908 831211<br/>WhatsApp: 07919 111062<br/>Email: support@onecab.co.uk</p>'
WHERE app_scope = 'customer' AND slug = 'about_us';

UPDATE content_items SET content_html = '<h1>OneCab Customer Terms & Conditions</h1>
<p><strong>Last updated: March 2026</strong></p>
<h2>1. Acceptance of Terms</h2>
<p>By downloading, installing, or using the OneCab Customer App, you agree to be bound by these Terms and Conditions. If you do not agree, please do not use the service.</p>
<h2>2. Service Description</h2>
<p>OneCab provides a platform connecting passengers with licensed private hire drivers. OneCab acts as an intermediary and is not a transportation provider.</p>
<h2>3. Account Registration</h2>
<p>You must provide accurate information when creating your account. You are responsible for maintaining the confidentiality of your account credentials.</p>
<h2>4. Bookings & Cancellations</h2>
<p>Fares are calculated based on distance, time, and demand. Cancellation fees may apply if a trip is cancelled after a driver has been dispatched. Scheduled rides must be cancelled at least 30 minutes before the pickup time.</p>
<h2>5. Payments</h2>
<p>Payment is due at the end of each trip. We accept cash, debit/credit cards, and OneCab wallet balance. All fares include VAT where applicable.</p>
<h2>6. Passenger Conduct</h2>
<p>Passengers must treat drivers with respect. Abusive behaviour, damage to vehicles, or illegal activity will result in account suspension.</p>
<h2>7. Limitation of Liability</h2>
<p>OneCab is not liable for delays caused by traffic, weather, or other circumstances beyond our control. Maximum liability is limited to the fare paid for the trip in question.</p>
<h2>8. Data Protection</h2>
<p>Your personal data is processed in accordance with our Privacy Policy and applicable UK data protection legislation including UK GDPR.</p>'
WHERE app_scope = 'customer' AND slug = 'terms';

UPDATE content_items SET content_html = '<h1>OneCab Customer Privacy Policy</h1>
<p><strong>Effective: March 2026</strong></p>
<h2>1. Data Controller</h2>
<p>OneCab Ltd is the data controller for personal data collected through the Customer App.</p>
<h2>2. Information We Collect</h2>
<ul>
<li>Name, email address, and phone number</li>
<li>Payment information (processed securely via Stripe)</li>
<li>Location data during active trips</li>
<li>Trip history and preferences</li>
<li>Device information and app usage analytics</li>
</ul>
<h2>3. How We Use Your Data</h2>
<p>We use your data to: provide and improve our service, process payments, communicate with you about trips, ensure safety and security, and comply with legal obligations.</p>
<h2>4. Data Sharing</h2>
<p>We share limited data with drivers (your name, pickup location) to fulfil trips. We do not sell your personal data to third parties.</p>
<h2>5. Data Retention</h2>
<p>Trip records are retained for 7 years for tax and regulatory purposes. Account data is deleted within 30 days of account closure.</p>
<h2>6. Your Rights</h2>
<p>Under UK GDPR, you have the right to access, rectify, erase, and port your data. Contact us at support@onecab.co.uk to exercise these rights.</p>'
WHERE app_scope = 'customer' AND slug = 'privacy_policy';

UPDATE content_items SET content_html = '<h1>About OneCab — Driver Partner</h1>
<p>Join the OneCab network and grow your private hire business with the support of cutting-edge technology and a dedicated driver support team.</p>
<h2>Why Drive with OneCab?</h2>
<ul>
<li>Keep more of your earnings — competitive commission rates</li>
<li>Flexible hours — drive when it suits you</li>
<li>Instant fare visibility — see trip details before accepting</li>
<li>Weekly payouts with early cashout option</li>
<li>Dedicated driver support line</li>
<li>In-app wallet and earnings dashboard</li>
</ul>
<h2>Requirements</h2>
<p>All drivers must hold a valid Private Hire Vehicle (PHV) licence, PHD badge, and appropriate insurance. Vehicles must pass MOT and comply with local council requirements.</p>
<h2>Support</h2>
<p>Phone: 01908 831211<br/>WhatsApp: 07919 111062<br/>Email: support@onecab.co.uk</p>'
WHERE app_scope = 'driver' AND slug = 'about_us';

UPDATE content_items SET content_html = '<h1>OneCab Driver Terms & Conditions</h1>
<p><strong>Last updated: March 2026</strong></p>
<h2>1. Driver Agreement</h2>
<p>By registering as a driver partner on the OneCab platform, you agree to these terms. You operate as an independent contractor, not an employee of OneCab.</p>
<h2>2. Eligibility</h2>
<p>You must hold a valid UK driving licence, Private Hire Driver (PHD) badge, and Private Hire Vehicle (PHV) licence issued by the relevant local authority.</p>
<h2>3. Vehicle Requirements</h2>
<p>Your vehicle must have a valid MOT certificate, appropriate private hire insurance, and be registered on the OneCab platform. Vehicle changes require admin approval.</p>
<h2>4. Commission & Payments</h2>
<p>OneCab deducts a commission from each completed trip. Commission rates are set per service area and driver category. Earnings are settled weekly or available via early cashout.</p>
<h2>5. Trip Acceptance</h2>
<p>You may accept or decline trip offers. Excessive cancellations or no-shows may result in temporary suspension. Acceptance rate is monitored for quality purposes.</p>
<h2>6. Conduct Standards</h2>
<p>Drivers must maintain professional conduct at all times. Discrimination, harassment, or dangerous driving will result in immediate suspension and potential deactivation.</p>
<h2>7. Documents & Compliance</h2>
<p>You must keep all required documents current. OneCab will send reminders before expiry. Expired documents will result in automatic suspension until renewed.</p>
<h2>8. Cash Trips</h2>
<p>For cash trips, the driver collects the full fare from the passenger. OneCab commission is deducted from the driver wallet balance.</p>'
WHERE app_scope = 'driver' AND slug = 'terms';

UPDATE content_items SET content_html = '<h1>OneCab Driver Privacy Policy</h1>
<p><strong>Effective: March 2026</strong></p>
<h2>1. Data Controller</h2>
<p>OneCab Ltd is the data controller for personal data collected through the Driver App.</p>
<h2>2. Information We Collect</h2>
<ul>
<li>Name, phone number, email address</li>
<li>Driving licence details and PHD badge number</li>
<li>Vehicle registration, MOT, and insurance documents</li>
<li>Real-time GPS location while online</li>
<li>Trip and earnings history</li>
<li>Bank/Stripe account details for payouts</li>
</ul>
<h2>3. How We Use Your Data</h2>
<p>We use your data to: verify your identity and eligibility, dispatch trip offers, process payments and commissions, ensure passenger safety, and comply with licensing regulations.</p>
<h2>4. Location Tracking</h2>
<p>Your location is tracked while you are online in the Driver App. This data is used for dispatch, ETA calculations, and safety. Location tracking stops when you go offline.</p>
<h2>5. Data Sharing</h2>
<p>Limited driver information (name, vehicle details, photo) is shared with passengers during active trips. We share data with licensing authorities when legally required.</p>
<h2>6. Your Rights</h2>
<p>You have the right to access, correct, and request deletion of your data under UK GDPR. Contact support@onecab.co.uk.</p>'
WHERE app_scope = 'driver' AND slug = 'privacy_policy';

UPDATE content_items SET content_html = '<h1>OneCab Corporate Travel Solutions</h1>
<p>Streamline your business travel with OneCab''s corporate account platform. Manage employee rides, control spend, and access detailed reporting — all from one dashboard.</p>
<h2>Features</h2>
<ul>
<li><strong>Centralised Billing</strong> — One monthly invoice for all company trips</li>
<li><strong>Spend Controls</strong> — Set per-trip limits, monthly budgets, and approval workflows</li>
<li><strong>Employee Management</strong> — Add and manage authorised riders by department</li>
<li><strong>Real-time Tracking</strong> — Monitor active trips across your organisation</li>
<li><strong>Detailed Reporting</strong> — Export trip data, cost breakdowns, and usage analytics</li>
<li><strong>Volume Discounts</strong> — Automatic tiered discounts based on monthly trip volume</li>
</ul>
<h2>How It Works</h2>
<ol>
<li>Apply for a corporate account</li>
<li>Add employees and set travel policies</li>
<li>Employees book rides using the OneCab app</li>
<li>Trips are billed to your corporate account</li>
<li>Receive a consolidated invoice at month end</li>
</ol>
<h2>Get Started</h2>
<p>Contact our corporate team to set up your account:<br/>Email: corporate@onecab.co.uk<br/>Phone: 01908 831211</p>'
WHERE app_scope = 'corporate' AND slug = 'corporate_page';
