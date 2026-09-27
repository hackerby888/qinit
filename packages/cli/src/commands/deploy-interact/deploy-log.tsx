import { Box, Text } from "ink";
import { deploymentLog, type ContractStatus, type DeploymentNote } from "../../ops/deploy";
import { SectionHeader, Table, termCols, theme } from "../../ui";

function toneColor(tone: ContractStatus["tone"]): string {
    return tone === "ok" ? theme.ok : tone === "fail" ? theme.err : tone === "active" ? theme.info : theme.mute;
}

function severityColor(text: string): string | undefined {
    return /^(✗|ERROR)/.test(text) ? theme.err : text.startsWith("⚠") ? theme.warn : undefined;
}

// `limit` bounds the remarks only: the contract rows are as many as the deployment has contracts.
export function DeployLog({ notes, limit }: { notes: readonly DeploymentNote[]; limit?: number }) {
    const log = deploymentLog(notes);
    const lines = limit === undefined ? log.lines : log.lines.slice(-limit);
    const topicWidth = Math.max(0, ...lines.map((line) => line.topic?.length ?? 0));
    const width = Math.min(termCols(), 78);

    return (
        <Box flexDirection="column">
            {log.contracts.length > 0 && (
                <Box flexDirection="column">
                    <SectionHeader title="contracts" width={width} />
                    <Box marginLeft={2}>
                        <Table
                            width={termCols() - 2}
                            columns={[
                                { header: "contract" },
                                { header: "slot", align: "right" },
                                { header: "kind", dim: true },
                                { header: "status", color: (row) => toneColor(log.contracts[row].tone) },
                                { header: "source", dim: true },
                            ]}
                            rows={log.contracts.map((contract) => [
                                contract.name,
                                String(contract.slot),
                                contract.kind,
                                contract.tone === "active" ? `${contract.status}…` : contract.status,
                                contract.source ?? "",
                            ])}
                        />
                    </Box>
                </Box>
            )}
            {lines.length > 0 && (
                <Box flexDirection="column">
                    <SectionHeader title="notes" width={width} />
                    <Box flexDirection="column" marginLeft={2}>
                        {lines.map((line, index) =>
                            line.topic ? (
                                <Text key={index}>
                                    <Text color={theme.info}>{line.topic.padEnd(topicWidth)}</Text>
                                    {"  "}
                                    {line.text}
                                </Text>
                            ) : (
                                <Text key={index} color={severityColor(line.text)} dimColor={!severityColor(line.text)}>
                                    {line.text}
                                </Text>
                            ),
                        )}
                    </Box>
                </Box>
            )}
        </Box>
    );
}
