-- Add RLS policies for customers table so admins can manage riders
CREATE POLICY "Admins can read all customers"
ON public.customers
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update customers"
ON public.customers
FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete customers"
ON public.customers
FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users can read own profile"
ON public.customers
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
ON public.customers
FOR UPDATE
USING (auth.uid() = user_id);

-- Create rider_feedback table for customer feedback/ratings
CREATE TABLE public.rider_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id uuid REFERENCES public.trips(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  driver_id uuid REFERENCES public.drivers(id),
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  feedback_type text DEFAULT 'trip' CHECK (feedback_type IN ('trip', 'app', 'support', 'general')),
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
  admin_notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS on rider_feedback
ALTER TABLE public.rider_feedback ENABLE ROW LEVEL SECURITY;

-- RLS policies for rider_feedback
CREATE POLICY "Admins can read all feedback"
ON public.rider_feedback
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update feedback"
ON public.rider_feedback
FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete feedback"
ON public.rider_feedback
FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Customers can create feedback"
ON public.rider_feedback
FOR INSERT
WITH CHECK (auth.uid() = customer_id);

CREATE POLICY "Customers can read own feedback"
ON public.rider_feedback
FOR SELECT
USING (auth.uid() = customer_id);

-- Add trigger for updated_at
CREATE TRIGGER update_rider_feedback_updated_at
BEFORE UPDATE ON public.rider_feedback
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();