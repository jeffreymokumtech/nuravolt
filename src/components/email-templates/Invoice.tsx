import React from 'react';

const InvoiceTemplate = (props: any) => {
    return (
        <div className="max-w-3xl mx-auto p-8 bg-white">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-gray-900 mb-6">Invoice</h1>

                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <p className="text-sm text-gray-600">
                            <span className="font-medium">Invoice number: </span>
                            {props.id}
                        </p>
                        <p className="text-sm text-gray-600">
                            <span className="font-medium">Date paid: </span>
                            {props.paid_date}
                        </p>
                    </div>
                </div>
            </div>

            {/* Address Section */}
            <div className="grid grid-cols-2 gap-8 mb-8">
                <div>
                    <h2 className="text-lg font-semibold mb-3">From:</h2>
                    <div className="text-sm text-gray-600 space-y-1">
                        <p className="font-medium">DB2 Software Ltd</p>
                        <p>38 Fawkner Way</p>
                        <p>Stanford In The Vale</p>
                        <p>Faringdon</p>
                        <p>United Kingdom</p>
                        <p>SN7 8FF</p>
                    </div>
                </div>

                <div>
                    <h2 className="text-lg font-semibold mb-3">To:</h2>
                    <div className="text-sm text-gray-600 h-24 border border-dashed border-gray-300 rounded-md p-3">
                        <span>
                            {props.data}
                        </span>
                    </div>
                </div>
            </div>

            {/* Invoice Table */}
            <div className="mb-8">
                <table className="w-full">
                    <thead>
                    <tr className="border-b border-gray-200">
                        <th className="py-3 text-left font-semibold text-gray-700">Description</th>
                        <th className="py-3 text-center font-semibold text-gray-700">Qty</th>
                        <th className="py-3 text-right font-semibold text-gray-700">Unit price</th>
                        <th className="py-3 text-right font-semibold text-gray-700">Amount</th>
                    </tr>
                    </thead>
                    <tbody>
                    <tr className="border-b border-gray-200">
                        <td className="py-4 text-sm text-gray-600">Nextjs code boilerplate</td>
                        <td className="py-4 text-center text-sm text-gray-600">1</td>
                        <td className="py-4 text-right text-sm text-gray-600">{props.price}</td>
                        <td className="py-4 text-right text-sm text-gray-600">{props.price}</td>
                    </tr>
                    </tbody>
                </table>
            </div>

            {/* Totals */}
            <div className="border-t border-gray-200 pt-4">
                <div className="space-y-2">
                    <div className="flex justify-between text-sm text-gray-600">
                        <span>Subtotal:</span>
                        <span></span>
                    </div>
                    <div className="flex justify-between text-sm font-medium text-gray-800">
                        <span>Total:</span>
                        <span></span>
                    </div>
                    <div className="flex justify-between text-sm font-medium text-blue-500">
                        <span>Total amount paid:</span>
                        <span></span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default InvoiceTemplate;