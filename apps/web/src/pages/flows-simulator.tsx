import {useState} from 'react';
import {FlaskConical,Play} from 'lucide-react';
import {Fields,Notice,Feedback,JsonDetail,useWorkspace,type Field} from '../components/shared';
import {Button} from '../components/ui/button';
import {Modal} from '../components/ui/dialog';
import {useData,useAction,params,type Row} from '../lib/api';
export function Simulator({snapshot}: {snapshot: Row}) {
  const { environment } = useWorkspace();
  const [open, setOpen] = useState(false);
  const accounts = useData(`/channel-accounts${params("SIMULATION")}`);
  const offers = useData(`/offers${params("SIMULATION")}`);
  const workflows = useData(`/workflows${params("SIMULATION")}`);
  const [values, setValues] = useState<Record<string, string>>({
    contact_name: "Contacto de prueba",
    account_id: String(snapshot.account_id),
    offer_version_id: String(snapshot.offer_version_id),
    workflow_version_id: String(snapshot.workflow_version_id),
  });
  const [run, setRun] = useState<Row | null>(null);
  const mutation = useAction("SIMULATION");
  const [seconds, setSeconds] = useState("1800");
  const commands = useData<Row>(
    `/commands/${run?.command_id}${params("SIMULATION")}`,
    !!run,
    1000,
  );
  const fields: Field[] = [
    {
      name: "account_id",
      label: "Cuenta simulada",
      type: "select",
      required: true,
      options: (accounts.data ?? [])
        .filter((a) => a.provider === "simulator")
        .map((a) => ({ value: a.id, label: a.name ?? a.id })),
    },
    {
      name: "offer_version_id",
      label: "Oferta",
      type: "select",
      required: true,
      options: (offers.data ?? []).map((a) => ({
        value: a.id,
        label: a.name ?? a.id,
      })),
    },
    {
      name: "workflow_version_id",
      label: "Versión de flujo",
      type: "select",
      options: (workflows.data ?? [])
        .filter((w) => w.status === "PUBLISHED")
        .map((a) => ({ value: a.id, label: a.name ?? a.id })),
    },
    { name: "contact_name", label: "Nombre ficticio", required: true },
  ];
  async function start() {
    try {
      setRun(
        (await mutation.mutateAsync({
          path: "/simulations",
          body: { ...values, environment: "SIMULATION" },
        })) as Row,
      );
    } catch {
      /* shown below */
    }
  }
  async function advance() {
    const id = run?.id;
    if (id)
      await mutation.mutateAsync({
        path: `/simulations/${id}/advance`,
        body: { seconds: Number(seconds) },
      });
  }
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <FlaskConical />
        Simulador
      </Button>
      <Modal
        title="Simular una venta"
        description="Usa cuentas ficticias y reloj virtual. El recorrido persiste en el entorno Simulación."
        open={open}
        onOpenChange={setOpen}
      >
        {environment === "REAL" && (
          <Notice>
            El simulador usa exclusivamente datos y cuentas del entorno de
            simulación.
          </Notice>
        )}
        <Fields fields={fields} values={values} setValues={setValues} />
        <div className="form-footer">
          <Button
            onClick={() => {
              void start();
            }}
            disabled={
              mutation.isPending ||
              !values.account_id ||
              !values.offer_version_id
            }
          >
            <Play />
            Iniciar simulación
          </Button>
        </div>
        {run && (
          <>
            <Notice>
              Comando registrado. Los mensajes, pedidos y eventos ficticios
              aparecen en este laboratorio al cerrar el simulador.
            </Notice>
            <div className="button-group">
              <label className="inline-field">
                Avanzar reloj
                <input
                  type="number"
                  value={seconds}
                  onChange={(e) => setSeconds(e.target.value)}
                  min={1}
                />
              </label>
              <Button
                variant="secondary"
                onClick={() => {
                  void advance();
                }}
                disabled={mutation.isPending}
              >
                Avanzar segundos
              </Button>
            </div>
            <JsonDetail
              value={commands.data ?? run}
              title="Estado del comando y resultado"
            />
          </>
        )}
        <Feedback error={mutation.error} />
      </Modal>
    </>
  );
}
