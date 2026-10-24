-- Efesto (docs/EFESTO.md): el agente lee de muchos sistemas, no solo de OPC UA.
-- Cada máquina dice de qué fuente del agente sale (el nombre en fuentes.json, que vive en la
-- fábrica: ni direcciones ni claves de la planta se guardan aquí) y cada tag puede llevar ajustes
-- (escala, desplazamiento, mapa de estados, bit, datos en hexadecimal).
alter table plant_machine add column source_name text;
alter table plant_tag add column settings jsonb;
