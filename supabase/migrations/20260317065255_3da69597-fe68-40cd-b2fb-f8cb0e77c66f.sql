
-- 1. Trigger: When driver is approved AND documents_approved, assign Bronze tier if no tier set
CREATE OR REPLACE FUNCTION public.assign_bronze_tier_on_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_bronze_id uuid;
BEGIN
  -- Only act when driver becomes fully approved (approval_status = 'approved' AND documents_approved = true)
  IF NEW.approval_status = 'approved' AND NEW.documents_approved = true
     AND NEW.category_id IS NULL THEN
    
    SELECT id INTO v_bronze_id
    FROM public.driver_categories
    WHERE LOWER(name) = 'bronze'
    AND is_active = true
    LIMIT 1;
    
    IF v_bronze_id IS NOT NULL THEN
      NEW.category_id := v_bronze_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_assign_bronze_tier ON public.drivers;
CREATE TRIGGER tr_assign_bronze_tier
  BEFORE UPDATE ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_bronze_tier_on_approval();

-- 2. Trigger: Prevent driver going online unless approved + documents_approved
CREATE OR REPLACE FUNCTION public.enforce_online_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- If trying to go online, enforce eligibility
  IF NEW.is_online = true AND (OLD.is_online IS DISTINCT FROM true) THEN
    IF NEW.approval_status != 'approved' OR NEW.documents_approved != true THEN
      NEW.is_online := false;
    END IF;
  END IF;
  
  -- If approval revoked or docs unapproved, force offline
  IF (NEW.approval_status != 'approved' OR NEW.documents_approved != true) THEN
    NEW.is_online := false;
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_enforce_online_eligibility ON public.drivers;
CREATE TRIGGER tr_enforce_online_eligibility
  BEFORE UPDATE ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_online_eligibility();

-- 3. Also enforce on INSERT (new drivers must be offline)
CREATE OR REPLACE FUNCTION public.enforce_new_driver_offline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  NEW.is_online := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_enforce_new_driver_offline ON public.drivers;
CREATE TRIGGER tr_enforce_new_driver_offline
  BEFORE INSERT ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_new_driver_offline();

-- 4. Function: Auto-promote driver tier after trip completion
CREATE OR REPLACE FUNCTION public.auto_promote_driver_tier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id uuid;
  v_completed_trips integer;
  v_current_tier RECORD;
  v_next_tier RECORD;
BEGIN
  -- Only trigger on trip completion
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') AND NEW.driver_id IS NOT NULL THEN
    v_driver_id := NEW.driver_id;
    
    -- Count completed trips
    SELECT COUNT(*) INTO v_completed_trips
    FROM public.trips
    WHERE driver_id = v_driver_id AND status = 'completed';
    
    -- Get current tier
    SELECT dc.* INTO v_current_tier
    FROM public.driver_categories dc
    JOIN public.drivers d ON d.category_id = dc.id
    WHERE d.id = v_driver_id;
    
    IF v_current_tier IS NULL THEN
      RETURN NEW;
    END IF;
    
    -- Check if current tier target is met
    IF v_current_tier.trip_target IS NOT NULL AND v_completed_trips >= v_current_tier.trip_target THEN
      -- Get next tier (next level_order)
      SELECT * INTO v_next_tier
      FROM public.driver_categories
      WHERE level_order > v_current_tier.level_order
      AND is_active = true
      ORDER BY level_order ASC
      LIMIT 1;
      
      IF v_next_tier IS NOT NULL THEN
        UPDATE public.drivers
        SET category_id = v_next_tier.id, updated_at = now()
        WHERE id = v_driver_id;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_auto_promote_driver_tier ON public.trips;
CREATE TRIGGER tr_auto_promote_driver_tier
  AFTER UPDATE ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_promote_driver_tier();
