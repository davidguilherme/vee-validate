import { watch, ref, Ref, isRef, reactive, computed, onMounted, toRefs, watchEffect } from 'vue';
import { validate } from './validate';
import {
  FormController,
  ValidationResult,
  MaybeReactive,
  FieldComposite,
  GenericValidateFunction,
  Flag,
  ValidationFlags,
} from './types';
import { normalizeRules, extractLocators, normalizeEventValue, unwrap, genFieldErrorId } from './utils';

interface FieldOptions {
  value: Ref<any>;
  disabled: MaybeReactive<boolean>;
  immediate?: boolean;
  bails?: boolean;
  form?: FormController;
}

type RuleExpression = MaybeReactive<string | Record<string, any> | GenericValidateFunction>;

/**
 * Creates a field composite.
 */
export function useField(
  fieldName: MaybeReactive<string>,
  rules: RuleExpression,
  opts?: Partial<FieldOptions>
): FieldComposite {
  const { value, form, immediate, bails, disabled } = normalizeOptions(opts);
  const { meta, errors, failedRules, onBlur, handleChange, reset, patch } = useValidationState(value);
  let schemaValidation: GenericValidateFunction | string | Record<string, any>;
  const normalizedRules = computed(() => {
    return normalizeRules(schemaValidation || unwrap(rules));
  });

  const runValidation = async (): Promise<ValidationResult> => {
    meta.pending.value = true;
    const result = await validate(value.value, normalizedRules.value, {
      name: unwrap(fieldName),
      values: form?.values.value ?? {},
      names: form?.names.value ?? {},
      bails,
    });

    // Must be updated regardless if a mutation is needed or not
    // FIXME: is this needed?
    meta.valid.value = result.valid;
    meta.invalid.value = !result.valid;

    return result;
  };

  const runValidationWithMutation = () => runValidation().then(patch);

  onMounted(() => {
    runValidation().then(result => {
      if (immediate) {
        patch(result);
      }
    });
  });

  const errorMessage = computed(() => {
    return errors.value[0];
  });

  const aria = useAriAttrs(fieldName, meta);

  const field = {
    name: fieldName,
    value: value,
    meta,
    errors,
    errorMessage,
    failedRules,
    aria,
    reset,
    validate: runValidationWithMutation,
    handleChange,
    onBlur,
    disabled,
    __setRules(schemaRules: GenericValidateFunction | string | Record<string, any>) {
      schemaValidation = schemaRules;
    },
  };

  useFormController(field, normalizedRules, form);

  watch(value, runValidationWithMutation, {
    deep: true,
  });

  if (isRef(rules)) {
    watch(rules, runValidationWithMutation, {
      deep: true,
    });
  }

  return field;
}

/**
 * Normalizes partial field options to include the full
 */
function normalizeOptions(opts: Partial<FieldOptions> | undefined): FieldOptions {
  const defaults = () => ({
    value: ref(null),
    immediate: false,
    bails: true,
    rules: '',
    disabled: false,
  });

  if (!opts) {
    return defaults();
  }

  return {
    ...defaults(),
    ...(opts ?? {}),
  };
}

/**
 * Manages the validation state of a field.
 */
function useValidationState(value: Ref<any>) {
  const errors: Ref<string[]> = ref([]);
  const { onBlur, reset: resetFlags, meta } = useMeta();
  const failedRules: Ref<Record<string, string>> = ref({});
  const initialValue = value.value;

  // Common input/change event handler
  const handleChange = (e: Event) => {
    value.value = normalizeEventValue(e);
    meta.dirty.value = true;
    meta.pristine.value = false;
  };

  // Updates the validation state with the validation result
  function patch(result: ValidationResult) {
    errors.value = result.errors;
    meta.changed.value = initialValue !== value.value;
    meta.valid.value = result.valid;
    meta.invalid.value = !result.valid;
    meta.validated.value = true;
    meta.pending.value = false;
    failedRules.value = result.failedRules;

    return result;
  }

  // Resets the validation state
  const reset = () => {
    errors.value = [];
    failedRules.value = {};
    resetFlags();
  };

  return {
    meta,
    errors,
    failedRules,
    patch,
    reset,
    onBlur,
    handleChange,
  };
}

/**
 * Associated fields with forms and watches any cross-field validation dependencies.
 */
function useFormController(field: FieldComposite, rules: Ref<Record<string, any>>, form?: FormController) {
  if (!form) return;

  // associate the field with the given form
  form.register(field);

  // extract cross-field dependencies in a computed prop
  const dependencies = computed(() => {
    return Object.keys(rules.value).reduce((acc: string[], rule: string) => {
      const deps = extractLocators(rules.value[rule]).map((dep: any) => dep.__locatorRef);
      acc.push(...deps);

      return acc;
    }, []);
  });

  // Adds a watcher that runs the validation whenever field dependencies change
  watchEffect(() => {
    // Skip if no dependencies
    if (!dependencies.value.length) {
      return;
    }

    // For each dependent field, validate it if it was validated before
    dependencies.value.forEach(dep => {
      if (dep in form.values.value && field.meta.validated.value) {
        field.validate();
      }
    });
  });
}

/**
 * Exposes meta flags state and some associated actions with them.
 */
function useMeta() {
  const initialMeta = (): ValidationFlags => ({
    untouched: true,
    touched: false,
    dirty: false,
    pristine: true,
    valid: false,
    invalid: false,
    validated: false,
    pending: false,
    changed: false,
    passed: false,
    failed: false,
  });

  const flags = reactive(initialMeta());

  const passed = computed(() => {
    return flags.valid && flags.validated;
  });

  const failed = computed(() => {
    return flags.invalid && flags.validated;
  });

  /**
   * Handles common onBlur meta update
   */
  const onBlur = () => {
    flags.touched = true;
    flags.untouched = false;
  };

  /**
   * Resets the flag state
   */
  function reset() {
    const defaults = initialMeta();
    Object.keys(flags).forEach((key: string) => {
      // Skip these, since they are computed anyways
      if (key === 'passed' || key === 'failed') {
        return;
      }

      flags[key as Flag] = defaults[key as Flag];
    });
  }

  return {
    meta: {
      ...toRefs(flags),
      passed,
      failed,
    },
    onBlur,
    reset,
  };
}

function useAriAttrs(fieldName: MaybeReactive<string>, meta: Record<Flag, Ref<boolean>>) {
  return computed(() => {
    return {
      'aria-invalid': meta.failed.value ? 'true' : 'false',
      'aria-describedBy': genFieldErrorId(unwrap(fieldName)),
    };
  });
}
